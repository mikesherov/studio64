#include <PR/ultratypes.h>

#include "audio/external.h"
#include "behavior_data.h"
#include "engine/behavior_script.h"
#include "engine/graph_node.h"
#include "eu_translation.h"
#include "game/area.h"
#include "game/game_init.h"
#include "game/ingame_menu.h"
#include "game/level_update.h"
#include "game/memory.h"
#include "game/object_helpers.h"
#include "game/object_list_processor.h"
#include "game/save_file.h"
#include "game/print.h"
#include "game/segment2.h"
#include "game/segment7.h"
#include "sm64.h"
#include "star_select.h"
#include "text_strings.h"
#include "prevent_bss_reordering.h"
#include "level_table.h"
#include "course_table.h"
#include "studio/studio.h"
#include <stdlib.h>
#ifdef TARGET_WEB
#include <emscripten.h>
#else
#define EMSCRIPTEN_KEEPALIVE
#define EM_ASM(...)
#endif

/**
 * @file star_select.c
 * This file implements how the star select screen (act selector) function.
 * That includes handles what stars can be selected, star selector types,
 * strings, act values, and star selector model rendering if a star is collected or not.
 */

// Studio 64: the act selector lists every star of the level, the game's own and
// the ones placed in the studio, all selectable. It also opens levels outside
// the main courses (custom levels) when the studio jumps there.
#define SEL_MAX 24
#define SEL_NAME 48

struct StudioSelStar {
    u8 name[SEL_NAME]; // game text encoding
    u8 collected;
    s8 act;            // act this star belongs to (0: none)
};

static struct StudioSelStar sSel[SEL_MAX];
static s32 sSelCount;
static u8 sSelTitle[SEL_NAME];
static s32 sSelMainCourse;  // course plaque, act names and coin score like the game
static f32 sSelSpacing;     // distance between the stars on screen (world units)
static f32 sSelScale;
static s32 sSelAutoFrames;  // goes on by itself after this many frames (0: waits for A)
static s32 sSelScore;       // best coin score of a custom level (the page keeps it)
static s32 sSelCoinStar;    // the 100 coin star is collected (it stays out of the row, like in the game)

// The star chosen when the level was entered (shown by the pause menu), -1: none.
s32 gStudioCurrentStar = -1;

// Star Selector count models printed in the act selector menu.
static struct Object *sStarSelectorModels[SEL_MAX];

// The act the course is loaded as, affects whether some objects spawn.
static s8 sLoadedActNum;

// Total number of stars that appear in the act selector menu.
static s8 sVisibleStars;

// Index value of the act selected in the act menu.
static s8 sSelectedActIndex = 0;

// Index value of the star that is selectable in the act menu.
// Excluding the next star, it doesn't count other transparent stars.
static s8 sSelectableStarIndex = 0;

// Act Selector menu timer that keeps counting until you choose an act.
static s32 sActSelectorMenuTimer = 0;

/**
 * Act Selector Star Type Loop Action
 * Defines a select type for a star in the act selector.
 */
void bhv_act_selector_star_type_loop(void) {
    switch (gCurrentObject->oStarSelectorType) {
        // If a star is not selected, don't rotate or change size
        case STAR_SELECTOR_NOT_SELECTED:
            gCurrentObject->oStarSelectorSize -= 0.1;
            if (gCurrentObject->oStarSelectorSize < 1.0) {
                gCurrentObject->oStarSelectorSize = 1.0;
            }
            gCurrentObject->oFaceAngleYaw = 0;
            break;
        // If a star is selected, rotate and slightly increase size
        case STAR_SELECTOR_SELECTED:
            gCurrentObject->oStarSelectorSize += 0.1;
            if (gCurrentObject->oStarSelectorSize > 1.3) {
                gCurrentObject->oStarSelectorSize = 1.3;
            }
            gCurrentObject->oFaceAngleYaw += 0x800;
            break;
        // If the 100 coin star is selected, rotate
        case STAR_SELECTOR_100_COINS:
            gCurrentObject->oFaceAngleYaw += 0x800;
            break;
    }
    // Scale act selector stars depending of the type selected
    cur_obj_scale(gCurrentObject->oStarSelectorSize * sSelScale);
    // Unused timer, only referenced here. Probably replaced by sActSelectorMenuTimer
    gCurrentObject->oStarSelectorTimer++;
}

// ASCII (from the page) to the game's text encoding. The menu font only has
// letters, digits and ' . , so everything else becomes a space there.
static void sel_from_ascii(u8 *dst, const char *src, s32 menuFont) {
    s32 n = 0;
    for (; *src != '\0' && n < SEL_NAME - 1; src++) {
        u8 c = (u8) *src, o = 0x9E;
        if (c >= 'a' && c <= 'z') {
            c -= 'a' - 'A';
        }
        if (c >= '0' && c <= '9') o = c - '0';
        else if (c >= 'A' && c <= 'Z') o = c - 'A' + 10;
        else if (c == '\'') o = 0x3E;
        else if (c == '.') o = 0x3F;
        else if (c == ',') o = 0x6F;
        else if (!menuFont) {
            switch (c) {
                case '-': o = 0x9F; break;
                case '(': o = 0xE1; break;
                case ')': o = 0xE3; break;
                case '&': o = 0xE5; break;
                case ':': o = 0xE6; break;
                case '!': o = 0xF2; break;
                case '%': o = 0xF3; break;
                case '?': o = 0xF4; break;
            }
        }
        if (o == 0x9E && (n == 0 || dst[n - 1] == 0x9E)) {
            continue;
        }
        dst[n++] = o;
    }
    while (n > 0 && dst[n - 1] == 0x9E) {
        n--;
    }
    dst[n] = 0xFF;
}

static void sel_from_game(u8 *dst, const u8 *src) {
    s32 n = 0;
    while (src[n] != 0xFF && n < SEL_NAME - 1) {
        dst[n] = src[n];
        n++;
    }
    dst[n] = 0xFF;
}

static struct StudioSelStar *sel_new(s32 collected, s32 act) {
    struct StudioSelStar *st;
    if (sSelCount >= SEL_MAX) {
        return NULL;
    }
    st = &sSel[sSelCount++];
    st->collected = collected != 0;
    st->act = act;
    return st;
}

// The page names the level and adds its studio stars (Module.studioIntroStars).
EMSCRIPTEN_KEEPALIVE
void studio_intro_title(const char *title) {
    sel_from_ascii(sSelTitle, title, FALSE);
}

EMSCRIPTEN_KEEPALIVE
void studio_intro_score(s32 coins) {
    sSelScore = coins;
}

EMSCRIPTEN_KEEPALIVE
void studio_intro_coin_star(s32 collected) {
    sSelCoinStar = collected != 0;
}

EMSCRIPTEN_KEEPALIVE
void studio_intro_add(const char *name, s32 collected) {
    struct StudioSelStar *st = sel_new(collected, 0);
    if (st != NULL) {
        sel_from_ascii(st->name, name, TRUE);
    }
}

// Lists the level's stars: the game's own from the save file, then the studio
// stars the page adds. Used by the star select screen and the pause menu.
s32 studio_stars_prepare(s32 levelNum, s32 courseNum) {
    u8 flags;
    s32 i;

    sSelCount = 0;
    sSelScore = 0;
    sSelCoinStar = FALSE;
    sSelTitle[0] = 0xFF;
    sSelMainCourse = courseNum >= COURSE_MIN && courseNum <= COURSE_STAGES_MAX;
    if (levelNum == LEVEL_BOWSER_1 || levelNum == LEVEL_BOWSER_2 || levelNum == LEVEL_BOWSER_3) {
        return 0; // the fight arenas: the stars belong to the course before them
    }
    if (courseNum != COURSE_NONE && courseNum < COURSE_CAKE_END) {
        flags = save_file_get_star_flags(gCurrSaveFileNum - 1, courseNum - 1);
        if (sSelMainCourse) {
            u8 **actNameTbl = segmented_to_virtual(seg2_act_name_table);
            for (i = 0; i < 6; i++) {
                struct StudioSelStar *st = sel_new(flags & (1 << i), i + 1);
                sel_from_game(st->name, segmented_to_virtual(actNameTbl[(courseNum - 1) * 6 + i]));
            }
            sSelCoinStar = (flags & (1 << 6)) != 0;
        } else if (courseNum == COURSE_PSS) {
            sel_from_ascii(sel_new(flags & 1, 0)->name, "Slide to the finish", TRUE);
            sel_from_ascii(sel_new(flags & 2, 0)->name, "Under 21 seconds", TRUE);
        } else {
            sel_from_ascii(sel_new(flags & 1, 0)->name, "Red coins", TRUE);
        }
    }
    EM_ASM({
        if (Module.studioIntroStars) Module.studioIntroStars($0);
    }, levelNum);
    if (sSelTitle[0] == 0xFF && courseNum != COURSE_NONE) {
        u8 **levelNameTbl = segmented_to_virtual(seg2_course_name_table);
        sel_from_game(sSelTitle, (u8 *) segmented_to_virtual(levelNameTbl[courseNum - 1]) + 3);
    }
    return sSelCount;
}

// Says whether a level outside the main courses shows its stars on entry
// (main courses always open the act selector).
s32 studio_intro_wanted(s32 levelNum, s32 courseNum) {
    s32 count = studio_stars_prepare(levelNum, courseNum);
    if (gStudioIntroMode != STUDIO_INTRO_JUMP || levelNum == LEVEL_BOWSER_1 || levelNum == LEVEL_BOWSER_2
        || levelNum == LEVEL_BOWSER_3) {
        return FALSE;
    }
    return levelNum == LEVEL_STUDIO || count > 0;
}

// The star a fresh selector points at: the first one not collected yet
// (the act the studio asked for, on a course).
static s32 sel_default_index(void) {
    s32 i;
    if (sSelMainCourse && gStudioAutoAct >= 1 && gStudioAutoAct <= 6) {
        return gStudioAutoAct - 1;
    }
    for (i = 0; i < sSelCount; i++) {
        if (!sSel[i].collected) {
            return i;
        }
    }
    return 0;
}

static f32 sel_star_x(s32 i) {
    return (i - (sVisibleStars - 1) * 0.5f) * sSelSpacing;
}

/**
 * Act Selector Init Action
 * Spawns a star model for every star of the level: bright when collected.
 */
void bhv_act_selector_init(void) {
    s32 i;
    for (i = 0; i < sVisibleStars; i++) {
        sStarSelectorModels[i] =
            spawn_object_abs_with_rot(gCurrentObject, 0, sSel[i].collected ? MODEL_STAR : MODEL_TRANSPARENT_STAR,
                                      bhvActSelectorStarType, sel_star_x(i), 248, -300, 0, 0, 0);
        sStarSelectorModels[i]->oStarSelectorSize = 1.0f;
    }
    // a collected 100 coin star turns next to the coin score, like in the game
    if (sSelCoinStar) {
        struct Object *star = spawn_object_abs_with_rot(gCurrentObject, 0, MODEL_STAR, bhvActSelectorStarType,
                                                        370, 24, -300, 0, 0, 0);
        star->oStarSelectorSize = 0.8f / sSelScale;
        star->oStarSelectorType = STAR_SELECTOR_100_COINS;
    }
}

/**
 * Act Selector Loop Action
 * Every star can be selected; choosing one stops the selector from going on by itself.
 */
void bhv_act_selector_loop(void) {
    s8 i;
    s8 before = sSelectableStarIndex;

    if (sVisibleStars == 0) {
        return;
    }
    handle_menu_scrolling(MENU_SCROLL_HORIZONTAL, &sSelectableStarIndex, 0, sVisibleStars - 1);
    if (sSelectableStarIndex != before) {
        sSelAutoFrames = 0;
    }
    sSelectedActIndex = sSelectableStarIndex;

    for (i = 0; i < sVisibleStars; i++) {
        sStarSelectorModels[i]->oStarSelectorType =
            sSelectedActIndex == i ? STAR_SELECTOR_SELECTED : STAR_SELECTOR_NOT_SELECTED;
    }
}

/**
 * Print the course number selected with the wood rgba16 course texture.
 */
#ifdef VERSION_EU
void print_course_number(s16 language) {
#else
void print_course_number(void) {
#endif
    u8 courseNum[4];

    create_dl_translation_matrix(MENU_MTX_PUSH, 158.0f, 81.0f, 0.0f);

    // Full wood texture in JP & US, lower part of it on EU
    gSPDisplayList(gDisplayListHead++, dl_menu_rgba16_wood_course);

#ifdef VERSION_EU
    // Change upper part of the wood texture depending of the language defined
    switch (language) {
        case LANGUAGE_ENGLISH:
            gSPDisplayList(gDisplayListHead++, dl_menu_texture_course_upper);
            break;
        case LANGUAGE_FRENCH:
            gSPDisplayList(gDisplayListHead++, dl_menu_texture_niveau_upper);
            break;
        case LANGUAGE_GERMAN:
            gSPDisplayList(gDisplayListHead++, dl_menu_texture_kurs_upper);
            break;
    }

    gSPDisplayList(gDisplayListHead++, dl_menu_rgba16_wood_course_end);
#endif

    gSPPopMatrix(gDisplayListHead++, G_MTX_MODELVIEW);
    gSPDisplayList(gDisplayListHead++, dl_rgba16_text_begin);
    gDPSetEnvColor(gDisplayListHead++, 255, 255, 255, 255);

    int_to_str(gCurrCourseNum, courseNum);

    if (gCurrCourseNum < 10) { // 1 digit number
        print_hud_lut_string(HUD_LUT_GLOBAL, 152, 158, courseNum);
    } else { // 2 digit number
        print_hud_lut_string(HUD_LUT_GLOBAL, 143, 158, courseNum);
    }

    gSPDisplayList(gDisplayListHead++, dl_rgba16_text_end);
}

#if defined(VERSION_JP) || defined(VERSION_SH)
#define ACT_NAME_X 158
#else
#define ACT_NAME_X 163
#endif

static void print_centered_menu_string(s16 x, s16 y, u8 *str) {
    print_menu_generic_string(get_str_x_pos_from_center(x, str, 8.0f), y, str);
}

/**
 * Print act selector strings: the coin score and course plaque on main courses,
 * the level name, the selected star's name and the numbers above the stars.
 */
void print_act_selector_strings(void) {
    unsigned char myScore[] = { TEXT_MYSCORE };
    u8 str[24];
    s32 i, done = 0;

    create_dl_ortho_matrix();

    if (sSelMainCourse) {
        gSPDisplayList(gDisplayListHead++, dl_rgba16_text_begin);
        gDPSetEnvColor(gDisplayListHead++, 255, 255, 255, 255);
        print_hud_my_score_coins(1, gCurrSaveFileNum - 1, gCurrCourseNum - 1, 155, 106);
        gSPDisplayList(gDisplayListHead++, dl_rgba16_text_end);
    }

    gSPDisplayList(gDisplayListHead++, dl_ia_text_begin);
    gDPSetEnvColor(gDisplayListHead++, 0, 0, 0, 255);
    if (sSelMainCourse && save_file_get_course_coin_score(gCurrSaveFileNum - 1, gCurrCourseNum - 1) != 0) {
        print_generic_string(102, 118, myScore);
    }
    if (!sSelMainCourse && sSelCount > 0) {
        // "★ 2 OF 5" where the coin score would be
        for (i = 0; i < sSelCount; i++) {
            done += sSel[i].collected;
        }
        str[0] = 0xFA;
        str[1] = 0x9E;
        int_to_str(done, str + 2);
        for (i = 2; str[i] != 0xFF; i++) {
        }
        str[i++] = 0x9E; // "OF": the font has no slash
        str[i++] = 0x18;
        str[i++] = 0x0F;
        str[i++] = 0x9E;
        int_to_str(sSelCount, str + i);
        print_generic_string(get_str_x_pos_from_center(160, str, 10.0f), 118, str);
    }
    if (sSelTitle[0] != 0xFF) {
        print_generic_string(get_str_x_pos_from_center(160, sSelTitle, 10.0f), 33, sSelTitle);
    }
    gSPDisplayList(gDisplayListHead++, dl_ia_text_end);

    if (sSelMainCourse) {
        print_course_number();
    }

    gSPDisplayList(gDisplayListHead++, dl_menu_ia8_text_begin);
    gDPSetEnvColor(gDisplayListHead++, 0, 0, 0, 255);
    if (sVisibleStars != 0) {
        print_centered_menu_string(ACT_NAME_X, 81, sSel[sSelectedActIndex].name);
    } else {
        u8 none[SEL_NAME];
        sel_from_ascii(none, "No stars yet", TRUE);
        print_centered_menu_string(ACT_NAME_X, 81, none);
    }

    // Numbers above the stars (only the selected one when they are packed tight).
    for (i = 0; i < sVisibleStars; i++) {
        if (sSelSpacing < 64.0f && i != sSelectedActIndex) {
            continue;
        }
        int_to_str(i + 1, str);
        print_menu_generic_string(156 + (s32) (sel_star_x(i) * 0.2237f) - (i >= 9 ? 7 : 3), 38, str);
    }

    gSPDisplayList(gDisplayListHead++, dl_menu_ia8_text_end);
}

/**
 * Geo function that Print act selector strings.
 *!@bug: This geo function is missing the third param. Harmless in practice due to o32 convention.
 */
#ifdef AVOID_UB
Gfx *geo_act_selector_strings(s16 callContext, UNUSED struct GraphNode *node, UNUSED void *context) {
#else
Gfx *geo_act_selector_strings(s16 callContext, UNUSED struct GraphNode *node) {
#endif
    if (callContext == GEO_CONTEXT_RENDER) {
        print_act_selector_strings();
    }
    return NULL;
}

/**
 * Initiates act selector values before entering a level: the stars were
 * listed by studio_intro_wanted when the level was chosen.
 */
s32 lvl_init_act_selector_values_and_stars(UNUSED s32 arg, UNUSED s32 unused) {
    sLoadedActNum = 0;
    sActSelectorMenuTimer = 0;
    sVisibleStars = sSelCount;
    sSelectedActIndex = sSelectableStarIndex = sel_default_index();
    // up to 8 stars sit like in the game, more move closer together and shrink
    sSelSpacing = sVisibleStars > 8 ? 1064.0f / (sVisibleStars - 1) : 152.0f;
    sSelScale = sSelSpacing < 120.0f ? sSelSpacing / 120.0f : 1.0f;
    sSelAutoFrames = gStudioIntroMode == STUDIO_INTRO_JUMP ? 75 : 0;
    gStudioInIntro = gStudioIntroMode != STUDIO_INTRO_NONE;
    if (gStudioInIntro) {
        EM_ASM({
            if (Module.studioIntro) Module.studioIntro(1, $0);
        }, gCurrLevelNum);
    }
    return 0;
}

static s32 sel_act_of(s32 index) {
    if (index >= 0 && index < sSelCount && sSel[index].act > 0) {
        return sSel[index].act;
    }
    return gStudioAutoAct > 0 ? gStudioAutoAct : 1;
}

/**
 * Loads act selector button actions with selected act value checks.
 * Also updates objects and returns act number selected after is chosen.
 * A studio jump goes on by itself unless the player picks a star; a jump
 * without intro takes the act it was given right away.
 */
s32 lvl_update_obj_and_load_act_button_actions(UNUSED s32 arg, UNUSED s32 unused) {
    s32 chosen = FALSE;

    if (gStudioIntroMode == STUDIO_INTRO_NONE) {
        if (sActSelectorMenuTimer >= 2) {
            gStudioCurrentStar = sel_default_index();
            sLoadedActNum = gStudioAutoAct > 0 ? gStudioAutoAct : 1;
            gDialogCourseActNum = sLoadedActNum;
        }
    } else if (sActSelectorMenuTimer >= 11) {
        if (gPlayer3Controller->buttonPressed & (A_BUTTON | START_BUTTON | B_BUTTON)) {
            play_sound(SOUND_MENU_STAR_SOUND_LETS_A_GO, gDefaultSoundArgs);
            chosen = TRUE;
        } else if (sSelAutoFrames > 0 && sActSelectorMenuTimer >= sSelAutoFrames) {
            chosen = TRUE;
        }
        if (chosen) {
            gStudioCurrentStar = sSelectedActIndex;
            sLoadedActNum = sel_act_of(sSelectedActIndex);
            gDialogCourseActNum = sLoadedActNum;
        }
    }
    if (sLoadedActNum != 0) {
        if (gStudioInIntro) {
            gStudioInIntro = FALSE;
            EM_ASM({
                if (Module.studioIntro) Module.studioIntro(0, $0);
            }, gCurrLevelNum);
        }
        gStudioIntroMode = STUDIO_INTRO_GAME;
        gStudioAutoAct = 0;
    }

    area_update_objects();
    sActSelectorMenuTimer++;
    return sLoadedActNum;
}

// ---------------------------------------------------------------------------
// Pause menu of custom levels: laid out like a course's (name, the star being
// played, star and coin score), plus a row with every star of the level.

#define PAUSE_TXT_STAR_X 98
#define PAUSE_ACT_NAME_X 116

void studio_pause_prepare(void) {
    if (gCurrLevelNum == LEVEL_STUDIO) {
        studio_stars_prepare(gCurrLevelNum, gCurrCourseNum);
    }
    EM_ASM({
        if (Module.studioPauseLevels) Module.studioPauseLevels();
    });
}

void studio_render_pause_level(void) {
    u8 textMyScore[] = { TEXT_MY_SCORE };
    u8 textStar[] = { TEXT_STAR };
    u8 textUnfilledStar[] = { TEXT_UNFILLED_STAR };
    u8 symStar[] = { GLYPH_STAR, GLYPH_SPACE };
    u8 symCoin[] = { GLYPH_COIN, GLYPH_SPACE };
    u8 symX[] = { GLYPH_MULTIPLY, GLYPH_SPACE };
    u8 row[SEL_MAX * 2 + 1], num[8];
    s32 i, done = 0, cur = gStudioCurrentStar;

    for (i = 0; i < sSelCount; i++) {
        done += sSel[i].collected;
        row[i * 2] = sSel[i].collected ? 0xFA : 0xFD;
        row[i * 2 + 1] = 0x9E;
    }
    row[sSelCount > 0 ? sSelCount * 2 - 1 : 0] = 0xFF;
    done += sSelCoinStar; // MY SCORE counts it, the row doesn't show it (like the game)
    if (cur < 0 || cur >= sSelCount) {
        cur = sel_default_index();
    }

    gSPDisplayList(gDisplayListHead++, dl_rgba16_text_begin);
    gDPSetEnvColor(gDisplayListHead++, 255, 255, 255, gDialogTextAlpha);
    if (done > 0) {
        print_hud_lut_string(HUD_LUT_GLOBAL, 118, 103, symStar);
        print_hud_lut_string(HUD_LUT_GLOBAL, 134, 103, symX);
        int_to_str(done, num);
        print_hud_lut_string(HUD_LUT_GLOBAL, 150, 103, num);
    }
    if (sSelScore > 0) {
        print_hud_lut_string(HUD_LUT_GLOBAL, 178, 103, symCoin);
        print_hud_lut_string(HUD_LUT_GLOBAL, 194, 103, symX);
        int_to_str(sSelScore, num);
        print_hud_lut_string(HUD_LUT_GLOBAL, 210, 103, num);
    }
    gSPDisplayList(gDisplayListHead++, dl_rgba16_text_end);

    gSPDisplayList(gDisplayListHead++, dl_ia_text_begin);
    gDPSetEnvColor(gDisplayListHead++, 255, 255, 255, gDialogTextAlpha);
    if (done > 0 || sSelScore > 0) {
        print_generic_string(62, 121, textMyScore);
    }
    if (sSelTitle[0] != 0xFF) {
        print_generic_string(get_str_x_pos_from_center(160, sSelTitle, 10.0f), 174, sSelTitle);
    }
    if (sSelCount > 0) {
        print_generic_string(get_str_x_pos_from_center(160, row, 10.0f), 157, row);
        print_generic_string(PAUSE_TXT_STAR_X, 140, sSel[cur].collected ? textStar : textUnfilledStar);
        print_generic_string(PAUSE_ACT_NAME_X, 140, sSel[cur].name);
    } else {
        u8 none[SEL_NAME];
        sel_from_ascii(none, "No stars yet", FALSE);
        print_generic_string(get_str_x_pos_from_center(160, none, 10.0f), 140, none);
    }
    gSPDisplayList(gDisplayListHead++, dl_ia_text_end);
}

// ---------------------------------------------------------------------------
// The castle's pause menu pages through the courses; the custom levels follow
// the secret stars, each with its stars and coin score.

#define PAUSE_LEVELS_MAX 48

struct StudioPauseLevel {
    u8 name[SEL_NAME];
    u8 stars[SEL_MAX * 2 + 1];
    s16 coins;
    s16 coinStar;
};

static struct StudioPauseLevel sPauseLevels[PAUSE_LEVELS_MAX];
s32 gStudioPauseLevelCount;

EMSCRIPTEN_KEEPALIVE
void studio_pause_levels_reset(void) {
    gStudioPauseLevelCount = 0;
}

// stars: one character per star, '1' collected, anything else not
EMSCRIPTEN_KEEPALIVE
void studio_pause_level(const char *name, const char *stars, s32 coins, s32 coinStar) {
    struct StudioPauseLevel *l;
    s32 n = 0;
    if (gStudioPauseLevelCount >= PAUSE_LEVELS_MAX) {
        return;
    }
    l = &sPauseLevels[gStudioPauseLevelCount++];
    sel_from_ascii(l->name, name, FALSE);
    for (; stars[n] != '\0' && n < SEL_MAX; n++) {
        l->stars[n * 2] = stars[n] == '1' ? 0xFA : 0xFD;
        l->stars[n * 2 + 1] = 0x9E;
    }
    l->stars[n > 0 ? n * 2 - 1 : 0] = 0xFF;
    l->coins = coins;
    l->coinStar = coinStar;
}

// One custom level's page in the castle's pause menu (x, y as the course pages).
void studio_render_pause_castle_level(s32 index, s16 x, s16 y) {
    u8 textCoin[] = { TEXT_COIN_X };
    u8 num[8];
    struct StudioPauseLevel *l = &sPauseLevels[index];
    if (index < 0 || index >= gStudioPauseLevelCount) {
        return;
    }
    if (l->stars[0] != 0xFF) {
        print_generic_string(x + 14, y + 13, l->stars);
    } else {
        u8 none[SEL_NAME];
        sel_from_ascii(none, "No stars yet", FALSE);
        print_generic_string(x + 14, y + 13, none);
    }
    if (l->coinStar) {
        u8 textStar[] = { TEXT_STAR };
        print_generic_string(x + 89, y - 5, textStar);
    }
    print_generic_string(x + 34, y - 5, textCoin);
    int_to_str(l->coins, num);
    print_generic_string(x + 54, y - 5, num);
    print_generic_string(get_str_x_pos_from_center(x + 51, l->name, 10.0f), y + 30, l->name);
}

// ---------------------------------------------------------------------------
// Course complete screen after a studio star: the level's name (custom levels
// have no course number) and the star's name instead of the game's act name.

static u8 sDoneTitle[SEL_NAME];
static u8 sDoneStar[SEL_NAME];
static s32 sDoneActive, sDoneCustom;

void print_hud_course_complete_coins(s16 x, s16 y);
void play_star_fanfare_and_flash_hud(s32 arg, u8 starNum);

void studio_complete_clear(void) {
    sDoneActive = FALSE;
}

void studio_complete_reset(s32 customLevel) {
    sDoneActive = TRUE;
    sDoneCustom = customLevel;
    sDoneTitle[0] = 0xFF;
    sel_from_ascii(sDoneStar, "Star", FALSE);
}

EMSCRIPTEN_KEEPALIVE
void studio_complete_info(const char *title, const char *star) {
    sel_from_ascii(sDoneTitle, title, FALSE);
    sel_from_ascii(sDoneStar, star, FALSE);
}

// Returns FALSE when the last star was one of the game's (its screen draws itself).
s32 studio_render_course_complete(void) {
    u8 textSymStar[] = { GLYPH_STAR, GLYPH_SPACE };
    u8 textCourse[] = { TEXT_COURSE };
    u8 textCatch[] = { TEXT_CATCH };
    u8 num[4];

    if (!sDoneActive) {
        return FALSE;
    }
    print_hud_course_complete_coins(118, 103);
    play_star_fanfare_and_flash_hud(1, 1 << ((gLastCompletedStarNum - 1) & 7));

    gSPDisplayList(gDisplayListHead++, dl_ia_text_begin);
    if (sDoneCustom) {
        gDPSetEnvColor(gDisplayListHead++, 0, 0, 0, gDialogTextAlpha);
        print_generic_string(65, 165, sDoneTitle);
        gDPSetEnvColor(gDisplayListHead++, 255, 255, 255, gDialogTextAlpha);
        print_generic_string(63, 167, sDoneTitle);
    } else {
        int_to_str(gLastCompletedCourseNum, num);
        gDPSetEnvColor(gDisplayListHead++, 0, 0, 0, gDialogTextAlpha);
        print_generic_string(65, 165, textCourse);
        print_generic_string(104, 165, num);
        gDPSetEnvColor(gDisplayListHead++, 255, 255, 255, gDialogTextAlpha);
        print_generic_string(63, 167, textCourse);
        print_generic_string(102, 167, num);
    }
    gSPDisplayList(gDisplayListHead++, dl_ia_text_end);

    gSPDisplayList(gDisplayListHead++, dl_rgba16_text_begin);
    gDPSetEnvColor(gDisplayListHead++, 255, 255, 255, gDialogTextAlpha);
    print_hud_lut_string(HUD_LUT_GLOBAL, 55, 77, textSymStar);
    gSPDisplayList(gDisplayListHead++, dl_rgba16_text_end);
    gSPDisplayList(gDisplayListHead++, dl_ia_text_begin);
    gDPSetEnvColor(gDisplayListHead++, 0, 0, 0, gDialogTextAlpha);
    print_generic_string(76, 145, sDoneStar);
    print_generic_string(220, 145, textCatch);
    gDPSetEnvColor(gDisplayListHead++, 255, 255, 255, gDialogTextAlpha);
    print_generic_string(74, 147, sDoneStar);
    print_generic_string(218, 147, textCatch);
    gSPDisplayList(gDisplayListHead++, dl_ia_text_end);
    return TRUE;
}

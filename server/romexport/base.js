// The decomp tree every ROM export builds on: the SM64 decompilation with Studio 64's changes.
// The changes are exact edits (find -> replace), so they apply the same on every system without a
// patch tool, and fail loudly if the decomp ever changes underneath them.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stubsC } from './calls.js';
import { overlaySources, hooksC } from './overlays.js';

// the upstream decompilation every base tree starts from (its newest commit, "ique hotfix")
export const UPSTREAM = { repo: 'n64decomp/sm64', commit: '9921382a68bb0c865e5e45eb594d9c64db59b1af' };

export const PATCHES = [
  // new compilers and make 4.4: the leveldata link rule must come before the generic one (make
  // 4.4 picks the first matching pattern), and armips needs C++17 with <cstdint>
  {
    file: 'Makefile',
    find: `$(BUILD_DIR)/%.elf: $(BUILD_DIR)/%.o
	$(call print,Linking ELF file:,$<,$@)
	$(V)$(LD) -e 0 -Ttext=$(SEGMENT_ADDRESS) -Map $@.map -o $@ $<
# Override for leveldata.elf, which otherwise matches the above pattern
.SECONDEXPANSION:
$(BUILD_DIR)/levels/%/leveldata.elf: $(BUILD_DIR)/levels/%/leveldata.o $(BUILD_DIR)/bin/$$(TEXTURE_BIN).elf
	$(call print,Linking ELF file:,$<,$@)
	$(V)$(LD) -e 0 -Ttext=$(SEGMENT_ADDRESS) -Map $@.map --just-symbols=$(BUILD_DIR)/bin/$(TEXTURE_BIN).elf -o $@ $<
`,
    replace: `# Override for leveldata.elf, which otherwise matches the generic pattern below
.SECONDEXPANSION:
$(BUILD_DIR)/levels/%/leveldata.elf: $(BUILD_DIR)/levels/%/leveldata.o
	$(call print,Linking ELF file:,$<,$@)
	$(V)$(LD) -e 0 -Ttext=$(SEGMENT_ADDRESS) -Map $@.map --just-symbols=$(BUILD_DIR)/bin/$(TEXTURE_BIN).elf -o $@ $<
$(BUILD_DIR)/%.elf: $(BUILD_DIR)/%.o
	$(call print,Linking ELF file:,$<,$@)
	$(V)$(LD) -e 0 -Ttext=$(SEGMENT_ADDRESS) -Map $@.map -o $@ $<
`,
  },
  {
    file: 'Makefile.split',
    find: `    $$(BUILD_DIR)/levels/$(1)/leveldata.elf: TEXTURE_BIN := $(2)
`,
    replace: `    $$(BUILD_DIR)/levels/$(1)/leveldata.elf: TEXTURE_BIN := $(2)
    $$(BUILD_DIR)/levels/$(1)/leveldata.elf: $$(BUILD_DIR)/bin/$(2).elf
`,
  },
  {
    file: 'tools/Makefile',
    find: 'armips_CFLAGS  := -std=c++11 -fno-exceptions -fno-rtti -pipe',
    replace: 'armips_CFLAGS  := -std=gnu++17 -include cstdint -fno-exceptions -fno-rtti -pipe',
  },
  {
    file: 'Makefile',
    find: 'COMPARE ?= 1\n',
    replace: 'COMPARE ?= 1\n\n# Studio 64: the Expansion Pak\'s 8 MB for the main pool (custom levels need the room)\nDEFINES += USE_EXT_RAM=1\n',
  },
  // the ROM's own code (src/s64), the engine modules with the compatibility header
  {
    file: 'Makefile',
    find: 'SRC_DIRS := src src/engine src/game src/audio src/menu src/buffers actors levels bin data assets asm lib sound\n',
    replace: 'SRC_DIRS := src src/engine src/game src/audio src/menu src/buffers src/s64 actors levels bin data assets asm lib sound\n',
  },
  {
    file: 'Makefile',
    find: '# Compile C code\n',
    replace: '# Studio 64 (src/s64): the engine modules build against the N64 compatibility header\n$(BUILD_DIR)/src/s64/%.o: CFLAGS += -include src/s64/n64compat.h -Isrc/s64\n$(BUILD_DIR)/src/s64/%.o: CC_CHECK_CFLAGS += -include src/s64/n64compat.h -Isrc/s64\n# (and the modules: overlays, server/romexport/overlays.js)\n$(BUILD_DIR)/src/studio/%.o: CFLAGS += -include src/s64/n64compat.h -Isrc/s64 -ffunction-sections -fdata-sections\n$(BUILD_DIR)/src/studio/%.o: CC_CHECK_CFLAGS += -include src/s64/n64compat.h -Isrc/s64\n\n# Compile C code\n',
  },
  // levels up to 16384 units from the centre, like the studio (32 x 32 collision cells)
  {
    file: 'src/engine/surface_collision.h',
    find: '#define LEVEL_BOUNDARY_MAX  0x2000 // 8192',
    replace: '#define LEVEL_BOUNDARY_MAX  0x4000 // 16384 (Studio 64)',
  },
  // collision pools sized per level: as many surfaces and partition nodes as its largest area
  // loads, plus room for the objects'
  {
    file: 'src/engine/surface_load.c',
    find: `static struct SurfaceNode *alloc_surface_node(void) {
    struct SurfaceNode *node = &sSurfaceNodePool[gSurfaceNodesAllocated];
    gSurfaceNodesAllocated++;`,
    replace: `static s32 sSurfaceNodePoolSize;

static struct SurfaceNode *alloc_surface_node(void) {
    struct SurfaceNode *node;
    if (gSurfaceNodesAllocated >= sSurfaceNodePoolSize) {
        return NULL; // full: the surface goes into fewer cells instead of past the pool's end
    }
    node = &sSurfaceNodePool[gSurfaceNodesAllocated];
    gSurfaceNodesAllocated++;`,
  },
  {
    file: 'src/engine/surface_load.c',
    find: `static struct Surface *alloc_surface(void) {

    struct Surface *surface = &sSurfacePool[gSurfacesAllocated];
    gSurfacesAllocated++;`,
    replace: `static struct Surface *alloc_surface(void) {
    struct Surface *surface;
    if (gSurfacesAllocated >= sSurfacePoolSize) {
        return NULL; // full: the triangle is left out
    }
    surface = &sSurfacePool[gSurfacesAllocated];
    gSurfacesAllocated++;`,
  },
  {
    file: 'src/engine/surface_load.c',
    find: `    s16 sortDir;
    s16 listIndex;
`,
    replace: `    s16 sortDir;
    s16 listIndex;

    if (newNode == NULL) {
        return;
    }
`,
  },
  {
    file: 'src/engine/surface_load.c',
    find: `    surface = alloc_surface();

    surface->vertex1[0] = x1;`,
    replace: `    surface = alloc_surface();
    if (surface == NULL) {
        return NULL;
    }

    surface->vertex1[0] = x1;`,
  },
  {
    file: 'src/engine/surface_load.c',
    find: `void alloc_surface_pools(void) {
    sSurfacePoolSize = 2300;
    sSurfaceNodePool = main_pool_alloc(7000 * sizeof(struct SurfaceNode), MEMORY_POOL_LEFT);
    sSurfacePool = main_pool_alloc(sSurfacePoolSize * sizeof(struct Surface), MEMORY_POOL_LEFT);`,
    replace: `static s32 surface_has_force(TerrainData surfaceType);
static s16 lower_cell_index(TerrainData coord);
static s16 upper_cell_index(TerrainData coord);
static s16 min_3(TerrainData a0, TerrainData a1, TerrainData a2);
static s16 max_3(TerrainData a0, TerrainData a1, TerrainData a2);

// How many surfaces an area's collision makes, and how many partition nodes they take.
static void count_area_terrain(TerrainData *data, s32 *surfaces, s32 *nodes) {
    TerrainData *vertexData = NULL;
    TerrainData type;
    s32 i, n, hasForce;

    while (TRUE) {
        type = *data++;
        if (type == TERRAIN_LOAD_VERTICES) {
            n = *data++;
            vertexData = data;
            data += 3 * n;
        } else if (type == TERRAIN_LOAD_CONTINUE) {
            continue;
        } else if (type == TERRAIN_LOAD_END || type == TERRAIN_LOAD_OBJECTS || type == TERRAIN_LOAD_ENVIRONMENT) {
            break;
        } else if (TERRAIN_LOAD_IS_SURFACE_TYPE_LOW(type) || TERRAIN_LOAD_IS_SURFACE_TYPE_HIGH(type)) {
            n = *data++;
            hasForce = surface_has_force(type);
            for (i = 0; i < n; i++) {
                TerrainData *a = vertexData + 3 * data[0];
                TerrainData *b = vertexData + 3 * data[1];
                TerrainData *c = vertexData + 3 * data[2];
                *surfaces += 1;
                *nodes += (upper_cell_index(max_3(a[0], b[0], c[0])) - lower_cell_index(min_3(a[0], b[0], c[0])) + 1)
                          * (upper_cell_index(max_3(a[2], b[2], c[2])) - lower_cell_index(min_3(a[2], b[2], c[2])) + 1);
                data += 3 + hasForce;
            }
        } else {
            break;
        }
    }
}

void alloc_surface_pools(void) {
    s32 i, surfaces, nodes, maxSurfaces = 0, maxNodes = 0;

    for (i = 0; i < 8; i++) {
        if (gAreaData[i].terrainData != NULL) {
            surfaces = nodes = 0;
            count_area_terrain(gAreaData[i].terrainData, &surfaces, &nodes);
            if (surfaces > maxSurfaces) maxSurfaces = surfaces;
            if (nodes > maxNodes) maxNodes = nodes;
        }
    }
    sSurfacePoolSize = maxSurfaces + 600;
    if (sSurfacePoolSize < 2300) sSurfacePoolSize = 2300;
    sSurfaceNodePoolSize = maxNodes + 5000;
    if (sSurfaceNodePoolSize < 7000) sSurfaceNodePoolSize = 7000;
    sSurfaceNodePool = main_pool_alloc(sSurfaceNodePoolSize * sizeof(struct SurfaceNode), MEMORY_POOL_LEFT);
    sSurfacePool = main_pool_alloc(sSurfacePoolSize * sizeof(struct Surface), MEMORY_POOL_LEFT);`,
  },
  // the pool size can pass 32767 surfaces in big custom levels
  { file: 'src/engine/surface_load.c', find: 's16 sSurfacePoolSize;', replace: 's32 sSurfacePoolSize;' },
  { file: 'src/engine/surface_load.h', find: 'extern s16 sSurfacePoolSize;', replace: 'extern s32 sSurfacePoolSize;' },
  // Surfaces go to the front of their cell's list (the sorted insertion walked the whole list for
  // every surface: minutes for a dense custom terrain), and the lookups pick the highest floor and
  // the lowest ceiling themselves -- which also ends the game's "surface cucking".
  {
    file: 'src/engine/surface_load.c',
    find: `    while (list->next != NULL) {
        priority = list->next->surface->vertex1[1] * sortDir;

        if (surfacePriority > priority) {
            break;
        }

        list = list->next;
    }

    newNode->next = list->next;`,
    replace: `    (void) priority;
    (void) surfacePriority;
    newNode->next = list->next;`,
  },
  {
    file: 'src/engine/surface_collision.c',
    find: `        *pheight = height;
        floor = surf;
        break;
    }`,
    replace: `        if (floor == NULL || height > *pheight) {
            *pheight = height;
            floor = surf;
        }
    }`,
  },
  {
    file: 'src/engine/surface_collision.c',
    find: `            *pheight = height;
            ceil = surf;
            break;`,
    replace: `            if (ceil == NULL || height < *pheight) {
                *pheight = height;
                ceil = surf;
            }`,
  },
  // Warp doors that need stars: the lowest parameter byte (the game's own star doors only check
  // the castle's keys), with the game's star door message
  {
    file: 'src/game/interaction.c',
    find: `    if (m->action == ACT_WALKING || m->action == ACT_DECELERATING) {
        if (warpDoorId == 1 && !(saveFlags & SAVE_FLAG_UNLOCKED_UPSTAIRS_DOOR)) {`,
    replace: `    if (m->action == ACT_WALKING || m->action == ACT_DECELERATING) {
        s16 needStars = (s16) (o->oBhvParams & 0xFF);
        if (needStars > 0) {
            s16 haveStars = save_file_get_total_star_count(gCurrSaveFileNum - 1, COURSE_MIN - 1, COURSE_MAX - 1);
            if (haveStars < needStars) {
                if (!sDisplayingDoorText) {
                    set_mario_action(m, ACT_READING_AUTOMATIC_DIALOG, (DIALOG_024 << 16) + (needStars - haveStars));
                }
                sDisplayingDoorText = TRUE;
                return FALSE;
            }
        }
        if (warpDoorId == 1 && !(saveFlags & SAVE_FLAG_UNLOCKED_UPSTAIRS_DOOR)) {`,
  },
];

// The hack's own settings, which an export writes into the ROM (rom.js, writeInfo): read at boot.
export const INFO_ROM = 0x01000000;
export const INFO_SIZE = 0xE00;

// The ROM's own code: n64/ (what only the ROM needs) and the engine's Studio 64 modules (the same
// code the web build runs), into src/s64/. The engine modules build against n64/n64compat.h.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENGINE = path.resolve(HERE, '..', '..', 'engine', 'src', 'studio');
// what the engine's older decomp called otherwise (renames.json)
export const RENAMES = JSON.parse(fs.readFileSync(path.join(HERE, 'renames.json'), 'utf8'));
const INSTRUMENT_NAMES = JSON.parse(fs.readFileSync(path.join(HERE, 'instrument_names.json'), 'utf8'));
export const ENGINE_MODULES = ['studio.h', 'studio_assets.h', 'objects.h', 'flow.c', 'motion.c', 'actor.c', 'rules.c', 'story.c', 'audio.c'];
// On the N64 an object's behavior is a RAM address and the behavior symbols are segment 0x13
// addresses (the PC port has one kind of address): comparisons go through segmented_to_virtual.
// What the engine tells the page (EM_ASM: Module.studioX(...)) is a C call here (s64_page_studioX,
// s64_story.c), and the older decomp's dialog answer is this one's.
// The page's call in an EM_ASM, in C: s64_page_<name>(arguments), where $N are the EM_ASM's
// arguments ("UTF8ToString($N)", ">>> 0", "| 0": as they are), JS strings C strings
function pageCall(js, args) {
  const split = (text) => {
    const out = [];
    let depth = 0, cur = '';
    for (const ch of text) {
      if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
      if ('([{'.includes(ch)) depth++;
      if (')]}'.includes(ch)) depth--;
      cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  };
  const m = /Module\.(studio\w+)\(/.exec(js.replace(/if\s*\(Module\.studio\w+\)/g, ''));
  if (!m) return null;
  const body = js.replace(/if\s*\(Module\.studio\w+\)/g, '');
  let i = m.index + m[0].length, depth = 1;
  const start = i;
  for (; i < body.length && depth > 0; i++) { if (body[i] === '(') depth++; else if (body[i] === ')') depth--; }
  const c = split(args);
  const mapped = split(body.slice(start, i - 1)).map((a) => a
    .replace(/^UTF8ToString\((\$\d+)\)$/, '$1')
    .replace(/\s*(>>>|\|)\s*0\s*$/, '')
    .replace(/^\$(\d+)$/, (x, n) => c[Number(n)] ?? '0')
    .replace(/^'([^']*)'$/, '"$1"'));
  return `s64_page_${m[1]}(${mapped.join(', ')});`;
}

function forN64(text) {
  return text
    .replace(/(->behavior\s*[!=]=\s*)(bhv\w+)\b/g, '$1(const BehaviorScript *) segmented_to_virtual($2)')
    .replace(/#ifdef TARGET_WEB\n(\s*want = EM_ASM_INT)/g, '#if 1\n$1')
    .replace(/EM_ASM(?:_INT)?\(\{([^}]*?Module\.studio\w+[\s\S]*?)\}\s*,\s*([^;]*?)\);/g, (m, js, args) => pageCall(js, args) || m)
    .replace(/^extern s8 gLastDialogResponse;\n/m, '')
    .replace(/^#define oBhvParams oBehParams\b.*\n/m, '') // (Tokyo's code has the newer name already)
    .replace(/\bgLastDialogResponse\b/g, 'gDialogResponse');
}

function sourceFiles() {
  const files = {};
  for (const f of fs.readdirSync(path.join(HERE, 'n64')).sort()) files[`src/s64/${f}`] = fs.readFileSync(path.join(HERE, 'n64', f), 'utf8');
  for (const f of ENGINE_MODULES) files[`src/s64/${f}`] = forN64(fs.readFileSync(path.join(ENGINE, f), 'utf8'));
  files['src/s64/s64_calls.inc'] = stubsC();
  // Studio 64's modules (overlays.js): their sources, and the game's calls into them
  const renamed = new RegExp(`\\b(${Object.keys(RENAMES).join('|')})\\b`, 'g');
  // (what the game itself reads of them is the game's: the weapons' draw flags, s64_glue.c)
  Object.assign(files, overlaySources((t) => forN64(t).replace(renamed, (w) => RENAMES[w])
    .replace(/^s32 (gStudioShotgunDraw|gStudioKatanaDraw)( = FALSE)?;/gm, 'extern s32 $1;')
    // (what a module allocates lives as long as the module: the level's memory, s64_ovl.c)
    .replace(/\bmalloc\(/g, 's64_level_malloc(')));
  files['src/s64/s64_ovl_hooks.c'] = hooksC();
  // the bank the project's sound effects play from (s64_sfx.c builds its instruments: these are
  // placeholders on a sample of the game)
  files['sound/sound_banks/27_studio_sfx.json'] = `${JSON.stringify({
    date: '2026-10-22', sample_bank: 'instruments', envelopes: { sfx: [[1, 32700], 'hang'] },
    instruments: Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`sfx${i}`, { release_rate: 208, envelope: 'sfx', sound: INSTRUMENT_NAMES['00'] }])),
    instrument_list: Array.from({ length: 16 }, (_, i) => `sfx${i}`),
  }, null, 2)}\n`;
  // Studio 64's own instrument banks (Tokyo's music: new instruments over the game's samples)
  const banks = path.join(ENGINE, '..', '..', 'sound', 'sound_banks');
  for (const f of fs.existsSync(banks) ? fs.readdirSync(banks).filter((x) => /^[0-9a-f]{2}_studio_\w+\.json$/.test(x)) : []) {
    // (the engine's decomp names the game's samples by number, this one by number and name)
    const bank = fs.readFileSync(path.join(banks, f), 'utf8');
    files[`sound/sound_banks/${f}`] = bank
      .replace(/("(?:sound|sound_lo|sound_hi|sample)":\s*")([0-9A-Fa-f]{2})"/g, (m, k, n) => `${k}${INSTRUMENT_NAMES[n.toUpperCase()] || n}"`);
    // ...and Studio 64's own samples it plays (Shoggoth World's: they come with Studio 64)
    for (const name of new Set(bank.match(/custom_\w+/g) || [])) {
      const aiff = path.join(banks, '..', 'samples', 'instruments', `${name}.aiff`);
      if (fs.existsSync(aiff)) files[`sound/samples/instruments/${name}.aiff`] = `base64:${fs.readFileSync(aiff).toString('base64')}`;
    }
  }
  // the engine's headers (its modules include them as "studio/...") and its object catalog
  const walk = (dir, rel = '') => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      // (not the Sunshine converter's output: Nintendo's, and only on computers with the disc)
      if (e.isDirectory()) { if (!/^sms\/(gen|stub)$/.test(`${rel}${e.name}`)) walk(path.join(dir, e.name), `${rel}${e.name}/`); }
      else if (e.name.endsWith('.h')) files[`src/studio/${rel}${e.name}`] = fs.readFileSync(path.join(dir, e.name), 'utf8');
    }
  };
  walk(ENGINE);
  // (the Sunshine characters' body list: the stand-in without the disc's, names and numbers only)
  files['src/studio/sms/gen/sms_bodies.h'] = fs.readFileSync(path.join(ENGINE, 'sms', 'stub', 'sms_bodies.h'), 'utf8');
  // (with this decomp's names for what the engine's older decomp called otherwise)
  const catalog = fs.readFileSync(path.join(ENGINE, 'gen', 'catalog.inc.c'), 'utf8')
    .replace(/\b[A-Za-z_]\w*\b/g, (w) => RENAMES[w] || w);
  files['src/studio/gen/catalog.inc.c'] = catalog;
  // what the catalog names from the engine's own modules: weak, so modules not in the ROM are NULL
  const weak = new Set(catalog.match(/\b(bhv(Sms|Sg|Kt|Tk|Studio)\w*|(stv|tokyo|tk|sms|sg|kt)_\w+_(geo|dl)\w*|(stv|tokyo|tk|sms|sg|kt)_\w+)\b/g));
  for (const m of catalog.matchAll(/#include "(studio\/[^"]+)"/g)) {
    const h = files[`src/${m[1]}`] || '';
    for (const d of h.matchAll(/extern\s+[^;(]*?\b(\w+)\s*(?:\[[^\]]*\])?\s*;/g)) weak.add(d[1]);
  }
  files['src/s64/s64_catalog_weak.inc'] = `// Made by server/romexport/base.js.\n${[...weak].sort().map((n) => `${/^bhv/.test(n) ? `extern const BehaviorScript ${n}[];\n` : ''}#pragma weak ${n}`).join('\n')}\n`;
  return files;
}
export const FILES = sourceFiles();

PATCHES.push(
  // a vertex index above 10922 times 3 does not fit in 16 bits (the original levels never had that many)
  { file: 'src/engine/surface_load.c', find: '    TerrainData offset1, offset2, offset3;\n', replace: '    s32 offset1, offset2, offset3; // (Studio 64: big levels)\n' },
);

// room for big levels and Studio 64's detailed characters in the display list each frame (the
// Expansion Pak has the memory)
PATCHES.push(
  { file: 'src/game/game_init.h', find: '#define GFX_POOL_SIZE 6400 ', replace: '#define GFX_POOL_SIZE 24000 ' },
  // ...and when a frame needs more anyway (many detailed characters in view), what does not fit is
  // drawn from a scratch buffer (wrong for that frame) instead of the game crashing on a NULL matrix
  {
    file: 'src/game/memory.c',
    find: `    if (gGfxPoolEnd - size >= (u8 *) gDisplayListHead) {
        gGfxPoolEnd -= size;
        ptr = gGfxPoolEnd;
    } else {
    }
    return ptr;`,
    replace: `    if (gGfxPoolEnd - size >= (u8 *) gDisplayListHead) {
        gGfxPoolEnd -= size;
        ptr = gGfxPoolEnd;
    } else if (size <= 1024) {
        static u64 sScratch[512];
        static u32 sScratchAt;
        sScratchAt = (sScratchAt + size <= sizeof(sScratch)) ? sScratchAt : 0;
        ptr = (u8 *) sScratch + sScratchAt;
        sScratchAt += size;
    }
    return ptr;`,
  },
);

// Studio 64's behaviors: their scripts in the behavior segment, declared with the game's
PATCHES.push(
  {
    file: 'data/behavior_data.c',
    find: 'const BehaviorScript bhvIntroScene[] = {\n    BEGIN(OBJ_LIST_DEFAULT),\n    OR_INT(oFlags, OBJ_FLAG_UPDATE_GFX_POS_AND_ANGLE),\n    BEGIN_LOOP(),\n        CALL_NATIVE(bhv_intro_scene_loop),\n    END_LOOP(),\n};\n',
    replace: 'const BehaviorScript bhvIntroScene[] = {\n    BEGIN(OBJ_LIST_DEFAULT),\n    OR_INT(oFlags, OBJ_FLAG_UPDATE_GFX_POS_AND_ANGLE),\n    BEGIN_LOOP(),\n        CALL_NATIVE(bhv_intro_scene_loop),\n    END_LOOP(),\n};\n\n#include "s64/s64_behaviors.inc"\n',
  },
  { file: 'include/behavior_data.h', find: '#endif // BEHAVIOR_DATA_H', replace: '#include "s64/s64_behaviors.h"\n\n#endif // BEHAVIOR_DATA_H' },
);

// the ROM's own code (src/s64) goes into the main segment, beside the game's
PATCHES.push(...['.text', '.data*', '.rodata*', '.bss*'].map((sec) => ({
  file: 'sm64.ld',
  find: `        BUILD_DIR/src/game*.o(${sec});\n`,
  replace: `        BUILD_DIR/src/game*.o(${sec});\n        BUILD_DIR/src/s64/[a-z]*.o(${sec});\n`,
})));

// what the engine's audio code (audio.c) uses of the game's: playing a sequence, and the next
// music playing even when it is the same id again (a slot whose song was replaced)
PATCHES.push(
  { file: 'src/audio/external.c', find: 'static void seq_player_play_sequence(u8 player, u8 seqId, u16 arg2) {', replace: 'void seq_player_play_sequence(u8 player, u8 seqId, u16 arg2) { // (Studio 64: also audio.c)' },
  // the project's own sound effects instead of the game's (s64_sfx.c)
  {
    file: 'src/audio/external.c',
    find: 'void play_sound(s32 soundBits, f32 *pos) {\n',
    replace: 's32 s64_sfx_hook(s32 soundBits, f32 *pos);\n\nvoid play_sound(s32 soundBits, f32 *pos) {\n    if (s64_sfx_hook(soundBits, pos)) { // Studio 64: a sound the project replaced\n        return;\n    }\n',
  },
  {
    file: 'src/game/sound_init.c',
    find: 'static u16 sCurrentMusic = MUSIC_NONE;\n',
    replace: 'static u16 sCurrentMusic = MUSIC_NONE;\n\nvoid studio_reset_current_music(void) {\n    sCurrentMusic = MUSIC_NONE;\n}\n',
  },
);

// motion (motion.c): placed objects follow a motion after their behavior, and the game's path
// objects (Koopa the Quick, the racing penguin, platforms on tracks) can follow paths drawn instead
PATCHES.push(
  { file: 'src/engine/behavior_script.c', find: '#include "behavior_script.h"\n', replace: '#include "behavior_script.h"\n#include "studio/objects.h"\n' },
  {
    file: 'src/engine/behavior_script.c',
    find: '                gCurrentObject->oPrevAction = gCurrentObject->oAction);\n    }\n\n    // Execute various code based on object flags.\n',
    replace: '                gCurrentObject->oPrevAction = gCurrentObject->oAction);\n    }\n\n    // Studio 64: objects placed in the studio can follow a motion (motion.c)\n    if (gCurrentObject->unused2 != 0) {\n        studio_motion_after_behavior(gCurrentObject);\n    }\n\n    // Execute various code based on object flags.\n',
  },
  { file: 'src/game/object_helpers.c', find: '#include "object_helpers.h"\n', replace: '#include "object_helpers.h"\n#include "studio/objects.h"\n' },
  {
    file: 'src/game/object_helpers.c',
    find: '    f32 objToNextX, objToNextY, objToNextZ;\n\n    if (o->oPathedPrevWaypointFlags == 0) {\n',
    replace: '    f32 objToNextX, objToNextY, objToNextZ;\n\n    studio_path_override_apply(o); // paths drawn in the studio\n\n    if (o->oPathedPrevWaypointFlags == 0) {\n',
  },
  { file: 'src/game/obj_behaviors_2.c', find: '#include "obj_behaviors_2.h"\n', replace: '#include "obj_behaviors_2.h"\n#include "studio/objects.h"\n' },
  {
    file: 'src/game/behaviors/platform_on_track.inc.c',
    find: '        o->oPlatformOnTrackStartWaypoint = segmented_to_virtual(sPlatformOnTrackPaths[pathIndex]);\n',
    replace: '        o->oPlatformOnTrackStartWaypoint = segmented_to_virtual(sPlatformOnTrackPaths[pathIndex]);\n        studio_track_override_apply(o); // a track drawn in the studio\n',
  },
);

// gameplay rules (rules.c): jump heights, gravity, running, air control, fall damage, moves that
// are switched off, swimming, coins, caps
PATCHES.push(
  { file: 'src/game/mario_step.c', find: '#include "mario_step.h"\n', replace: '#include "mario_step.h"\n#include "studio/objects.h"\n' },
  { file: 'src/game/mario_step.c', find: 'void apply_gravity(struct MarioState *m) {\n', replace: 'void apply_gravity(struct MarioState *m) {\n    f32 studioVelBefore = m->vel[1];\n' },
  {
    file: 'src/game/mario_step.c',
    find: '    } else {\n        m->vel[1] -= 4.0f;\n        if (m->vel[1] < -75.0f) {\n            m->vel[1] = -75.0f;\n        }\n    }\n}\n',
    replace: '    } else {\n        m->vel[1] -= 4.0f;\n        if (m->vel[1] < -75.0f) {\n            m->vel[1] = -75.0f;\n        }\n    }\n    studio_rules_gravity(m, studioVelBefore); // Studio 64 rules\n}\n',
  },
  { file: 'src/game/mario.c', find: '#include "mario.h"\n', replace: '#include "mario.h"\n#include "studio/objects.h"\n' },
  {
    file: 'src/game/mario.c',
    find: '        case ACT_JUMP_KICK:\n            m->vel[1] = 20.0f;\n            break;\n    }\n\n    m->peakHeight = m->pos[1];\n',
    replace: '        case ACT_JUMP_KICK:\n            m->vel[1] = 20.0f;\n            break;\n    }\n\n    studio_rules_airborne(m, action); // jump heights (Studio 64 rules)\n\n    m->peakHeight = m->pos[1];\n',
  },
  {
    file: 'src/game/mario.c',
    find: 'u32 set_mario_action(struct MarioState *m, u32 action, u32 actionArg) {\n',
    replace: 'u32 set_mario_action(struct MarioState *m, u32 action, u32 actionArg) {\n    // Studio 64 rules: switched-off moves become another move or nothing\n    action = studio_rules_filter_action(m, action);\n    if (action == 0) {\n        return TRUE;\n    }\n',
  },
  { file: 'src/game/mario_actions_moving.c', find: '#include "mario.h"\n', replace: '#include "mario.h"\n#include "studio/objects.h"\n' },
  {
    file: 'src/game/mario_actions_moving.c',
    find: '    targetSpeed = m->intendedMag < maxTargetSpeed ? m->intendedMag : maxTargetSpeed;\n\n    if (m->quicksandDepth > 10.0f) {\n        targetSpeed *= 6.25 / m->quicksandDepth;\n    }\n\n    if (m->forwardVel <= 0.0f) {\n        m->forwardVel += 1.1f;\n    } else if (m->forwardVel <= targetSpeed) {\n        m->forwardVel += 1.1f - m->forwardVel / 43.0f;\n',
    replace: '    maxTargetSpeed *= gStudioRules.runSpeed; // Studio 64 rules\n    targetSpeed = m->intendedMag * gStudioRules.runSpeed < maxTargetSpeed ? m->intendedMag * gStudioRules.runSpeed : maxTargetSpeed;\n\n    if (m->quicksandDepth > 10.0f) {\n        targetSpeed *= 6.25 / m->quicksandDepth;\n    }\n\n    if (m->forwardVel <= 0.0f) {\n        m->forwardVel += 1.1f;\n    } else if (m->forwardVel <= targetSpeed) {\n        m->forwardVel += (1.1f - m->forwardVel / (43.0f * gStudioRules.runSpeed)) * gStudioRules.runSpeed;\n',
  },
  {
    file: 'src/game/mario_actions_moving.c',
    find: '    if (m->forwardVel > 48.0f) {\n        m->forwardVel = 48.0f;\n    }\n\n    m->faceAngle[1] =\n',
    replace: '    if (m->forwardVel > 48.0f * gStudioRules.runSpeed) {\n        m->forwardVel = 48.0f * gStudioRules.runSpeed;\n    }\n\n    m->faceAngle[1] =\n',
  },
  { file: 'src/game/mario_actions_airborne.c', find: '#include "mario.h"\n', replace: '#include "mario.h"\n#include "studio/objects.h"\n' },
  { file: 'src/game/mario_actions_airborne.c', find: '            m->forwardVel += 1.5f * coss(intendedDYaw) * intendedMag;\n            m->faceAngle[1] += 512.0f * sins(intendedDYaw) * intendedMag;\n', replace: '            m->forwardVel += 1.5f * coss(intendedDYaw) * intendedMag * gStudioRules.airControl;\n            m->faceAngle[1] += 512.0f * sins(intendedDYaw) * intendedMag * gStudioRules.airControl;\n' },
  { file: 'src/game/mario_actions_airborne.c', find: '            m->forwardVel += intendedMag * coss(intendedDYaw) * 1.5f;\n            sidewaysSpeed = intendedMag * sins(intendedDYaw) * 10.0f;\n', replace: '            m->forwardVel += intendedMag * coss(intendedDYaw) * 1.5f * gStudioRules.airControl;\n            sidewaysSpeed = intendedMag * sins(intendedDYaw) * 10.0f * gStudioRules.airControl;\n' },
  {
    file: 'src/game/mario_actions_airborne.c',
    find: '        damageHeight = 1150.0f;\n    }\n\n#pragma GCC diagnostic pop\n',
    replace: '        damageHeight = 1150.0f;\n    }\n\n#pragma GCC diagnostic pop\n\n    // Studio 64 rules: how far Mario can fall without getting hurt (0: never); a trampoline catches him\n    if (gStudioRules.fallDamage <= 0.0f) {\n        return FALSE;\n    }\n    if (m->floor != NULL && studio_motion_is_trampoline(m->floor->object)) {\n        return FALSE;\n    }\n    damageHeight = gStudioRules.fallDamage;\n    if (fallHeight > damageHeight * (3000.0f / 1150.0f)) {\n        fallHeight = 3001.0f;\n    } else if (fallHeight > 3000.0f) {\n        fallHeight = 2999.0f;\n    }\n',
  },
  {
    file: 'src/game/mario_actions_airborne.c',
    find: '    if ((m->input & INPUT_A_PRESSED) && m->wallKickTimer != 0 && m->prevAction == ACT_AIR_HIT_WALL) {\n',
    replace: '    if ((m->input & INPUT_A_PRESSED) && m->wallKickTimer != 0 && m->prevAction == ACT_AIR_HIT_WALL\n        && !(gStudioRules.disabled & STUDIO_MOVE_WALL_KICK)) {\n',
  },
  {
    file: 'src/game/mario_actions_airborne.c',
    find: '    if (++(m->actionTimer) <= 2) {\n        if (m->input & INPUT_A_PRESSED) {\n            m->vel[1] = 52.0f;\n',
    replace: '    if (++(m->actionTimer) <= 2) {\n        if ((m->input & INPUT_A_PRESSED) && !(gStudioRules.disabled & STUDIO_MOVE_WALL_KICK)) {\n            m->vel[1] = 52.0f;\n',
  },
  { file: 'src/game/mario_actions_submerged.c', find: '#include "mario.h"\n', replace: '#include "mario.h"\n#include "studio/objects.h"\n' },
  {
    file: 'src/game/mario_actions_submerged.c',
    find: '    if (m->action & ACT_FLAG_SWIMMING) {\n        apply_water_current(m, step);\n    }\n',
    replace: '    if (gStudioRules.swimSpeed != 1.0f && (m->action & ACT_FLAG_SWIMMING)) {\n        step[0] *= gStudioRules.swimSpeed; // Studio 64 rules\n        step[1] *= gStudioRules.swimSpeed;\n        step[2] *= gStudioRules.swimSpeed;\n    }\n\n    if (m->action & ACT_FLAG_SWIMMING) {\n        apply_water_current(m, step);\n    }\n',
  },
  { file: 'src/game/interaction.c', find: '#include "mario.h"\n', replace: '#include "mario.h"\n#include "studio/objects.h"\n#include "studio/studio.h"\n' },
  {
    file: 'src/game/interaction.c',
    find: '    m->numCoins += o->oDamageOrCoinValue;\n    m->healCounter += 4 * o->oDamageOrCoinValue;\n\n    o->oInteractStatus = INT_STATUS_INTERACTED;\n\n    if (COURSE_IS_MAIN_COURSE(gCurrCourseNum)\n',
    replace: '    m->numCoins += o->oDamageOrCoinValue;\n    if (gStudioRules.coinHeal) {\n        m->healCounter += 4 * o->oDamageOrCoinValue;\n    }\n\n    o->oInteractStatus = INT_STATUS_INTERACTED;\n\n    if (COURSE_IS_MAIN_COURSE(gCurrCourseNum) && gStudioRules.coinStar\n',
  },
  { file: 'src/game/interaction.c', find: '        if (capTime > m->capTimer) {\n            m->capTimer = capTime;\n        }\n', replace: '        capTime = studio_rules_cap_time(capFlag, capTime); // Studio 64 rules\n        if (capTime > m->capTimer) {\n            m->capTimer = capTime;\n        }\n' },
  // locks (flow.c): stars, a key or an event keep a door, pipe or warp shut
  {
    file: 'src/game/interaction.c',
    find: 'u32 interact_warp(struct MarioState *m, UNUSED u32 interactType, struct Object *o) {\n    u32 action;\n',
    replace: 'u32 interact_warp(struct MarioState *m, UNUSED u32 interactType, struct Object *o) {\n    u32 action;\n    u32 studioRet;\n\n    if (studio_door_check(m, o, &studioRet)) { // Studio 64: a locked pipe or warp\n        return studioRet;\n    }\n',
  },
  {
    file: 'src/game/interaction.c',
    find: '    s16 warpDoorId = o->oBhvParams >> 24;\n    u32 actionArg;\n',
    replace: '    s16 warpDoorId = o->oBhvParams >> 24;\n    u32 actionArg;\n    u32 studioRet;\n\n    if ((m->action == ACT_WALKING || m->action == ACT_DECELERATING) && studio_door_check(m, o, &studioRet)) {\n        return studioRet; // Studio 64: a key or an event keeps it shut\n    }\n',
  },
  {
    file: 'src/game/interaction.c',
    find: '    s16 numStars = save_file_get_total_star_count(gCurrSaveFileNum - 1, COURSE_MIN - 1, COURSE_MAX - 1);\n\n    if (m->action == ACT_WALKING || m->action == ACT_DECELERATING) {\n        if (numStars >= requiredNumStars) {\n',
    replace: '    s16 numStars = save_file_get_total_star_count(gCurrSaveFileNum - 1, COURSE_MIN - 1, COURSE_MAX - 1);\n    u32 studioRet;\n\n    if ((m->action == ACT_WALKING || m->action == ACT_DECELERATING) && studio_door_check(m, o, &studioRet)) {\n        return studioRet;\n    }\n\n    if (m->action == ACT_WALKING || m->action == ACT_DECELERATING) {\n        if (numStars >= requiredNumStars) {\n',
  },
);

// dialogs (story.c): tagged characters say project dialogs, every text can be replaced, project
// dialogs have their own voice; a story cutscene: Start skips it; the story can hide the HUD
PATCHES.push(
  { file: 'src/game/ingame_menu.c', find: '#include "types.h"\n', replace: '#include "types.h"\n#include "studio/studio.h"\n' },
  {
    file: 'src/game/ingame_menu.c',
    find: '    if (gDialogID == DIALOG_NONE) {\n        gDialogID = dialog;\n',
    replace: '    if (gDialogID == DIALOG_NONE) {\n        dialog = studio_dialog_redirect(dialog); // Studio 64: tagged characters say project dialogs\n        gDialogID = dialog;\n',
    all: true,
  },
  {
    file: 'src/game/ingame_menu.c',
    find: '    dialog = segmented_to_virtual(dialogTable[gDialogID]);\n\n    // if the dialog entry is invalid, set the ID to DIALOG_NONE.\n    if (dialog == segmented_to_virtual(NULL)) {\n',
    replace: '    dialog = studio_dialog_entry(gDialogID); // Studio 64: replaced and project dialogs\n\n    // if the dialog entry is invalid, set the ID to DIALOG_NONE.\n    if (dialog == NULL || dialog == segmented_to_virtual(NULL)) {\n',
  },
  {
    file: 'src/game/ingame_menu.c',
    find: '    dialog = segmented_to_virtual(dialogTable[gDialogID]);\n    str = segmented_to_virtual(dialog->str);\n',
    replace: '    dialog = studio_dialog_entry(gDialogID); // Studio 64: replaced and project dialogs\n    str = segmented_to_virtual(dialog->str);\n',
  },
  { file: 'src/game/ingame_menu.c', find: '                play_dialog_sound(gDialogID);\n', replace: '                if (!studio_dialog_sound(gDialogID)) {\n                    play_dialog_sound(gDialogID);\n                }\n' },
  {
    file: 'src/game/level_update.c',
    find: '    u32 dialogActive = get_dialog_id() >= 0;\n    u32 intangible = (gMarioState->action & ACT_FLAG_INTANGIBLE) != 0;\n\n',
    replace: '    u32 dialogActive = get_dialog_id() >= 0;\n    u32 intangible = (gMarioState->action & ACT_FLAG_INTANGIBLE) != 0;\n    extern s32 gStudioStoryLock, gStudioStorySkip, gStudioStoryGrace;\n\n    // Studio 64: during a story cutscene Start skips it instead of pausing (and a second Start\n    // right after does not open the pause menu)\n    if (gStudioStoryLock) {\n        if (gPlayer1Controller->buttonPressed & START_BUTTON) {\n            gStudioStorySkip = TRUE;\n        }\n        return FALSE;\n    }\n    if (gStudioStoryGrace > 0) {\n        gStudioStoryGrace--;\n        return FALSE;\n    }\n\n',
  },
  { file: 'src/game/hud.c', find: '#include "level_update.h"\n', replace: '#include "level_update.h"\n#include "studio/objects.h"\n' },
  {
    file: 'src/game/hud.c',
    find: 'void render_hud(void) {\n    s16 hudDisplayFlags = gHudDisplay.flags;\n\n',
    replace: 'void render_hud(void) {\n    extern s32 gStudioHideHud;\n    extern void s64_story_render(void);\n    s16 hudDisplayFlags;\n\n    s64_vehicle_hud(); // Studio 64: a car\'s speed, a race (the game\'s HUD steps aside for a race; s64_hud.c)\n    hudDisplayFlags = gHudDisplay.flags & ~gStudioRules.hudHide; // Studio 64 rules\n    s64_story_render(); // the story\'s captions and fades\n    if (gStudioHideHud) { // a story cutscene\n        return;\n    }\n\n',
  },
);

// the story (s64_story.c): the cutscene camera, stars it hears of, objects it keeps hidden, warps
PATCHES.push(
  {
    file: 'src/game/camera.c',
    find: '    UNUSED struct Camera *c = gc->config.camera;\n\n    gc->rollScreen = gLakituState.roll;\n',
    replace: '    UNUSED struct Camera *c = gc->config.camera;\n    extern s32 gStudioCamEnabled;\n    extern f32 gStudioCamPos[3], gStudioCamFocus[3];\n    extern s32 studio_play_camera(f32 *pos, f32 *focus);\n\n    // Studio 64: the camera of a story cutscene, a car chase camera, the side-scrolling and top-down area cameras\n    if (gStudioCamEnabled) {\n        gc->rollScreen = 0;\n        gc->roll = 0;\n        vec3f_copy(gc->pos, gStudioCamPos);\n        vec3f_copy(gc->focus, gStudioCamFocus);\n        return;\n    }\n    if (studio_vehicle_camera(gc->pos, gc->focus) || studio_play_camera(gc->pos, gc->focus)) {\n        gc->rollScreen = 0;\n        gc->roll = 0;\n        return;\n    }\n\n    gc->rollScreen = gLakituState.roll;\n',
  },
  { file: 'src/game/rendering_graph_node.c', find: '        guPerspective(mtx, &perspNorm, node->fov, aspect, node->near, node->far, 1.0f);\n', replace: '        guPerspective(mtx, &perspNorm, s64_fov(node->fov), aspect, node->near, node->far, 1.0f);\n' },
  { file: 'src/game/rendering_graph_node.c', find: '#include "rendering_graph_node.h"\n', replace: '#include "rendering_graph_node.h"\n\nf32 s64_fov(f32 fov); // (Studio 64: the field of view of a story cutscene)\n' },
  {
    file: 'src/game/interaction.c',
    find: '    if (m->health >= 0x100) {\n        mario_stop_riding_and_holding(m);\n',
    replace: '    if (m->health >= 0x100) {\n        s64_story_star(o); // Studio 64: "When Mario collects a star"\n        mario_stop_riding_and_holding(m);\n',
  },
  { file: 'src/game/interaction.c', find: '#include "mario.h"\n#include "studio/objects.h"\n', replace: '#include "mario.h"\n#include "studio/objects.h"\n#include "s64/s64_hack.h"\n' },
  {
    file: 'src/engine/behavior_script.c',
    find: '    BhvCommandProc bhvCmdProc;\n    s32 bhvProcResult;\n\n',
    replace: '    BhvCommandProc bhvCmdProc;\n    s32 bhvProcResult;\n\n    // Studio 64: an object the story keeps hidden does nothing\n    {\n        extern s32 s64_story_hidden(u32 uid);\n        if (gCurrentObject->unused2 != 0 && s64_story_hidden(gCurrentObject->unused2)) {\n            gCurrentObject->header.gfx.node.flags &= ~GRAPH_RENDER_ACTIVE;\n            gCurrentObject->oIntangibleTimer = -1;\n            return;\n        }\n    }\n\n',
  },
  {
    file: 'src/game/level_update.c',
    find: 'void initiate_warp(s16 destLevel, s16 destArea, s16 destWarpNode, s32 arg3) {\n',
    replace: '// Studio 64: the story warps Mario (a warp node of its own, 0xEF, leads there)\nstatic struct ObjectWarpNode sS64WarpNode;\n\nvoid s64_warp_to(s16 level, s16 area, s16 node) {\n    struct ObjectWarpNode *n;\n    if (gCurrentArea == NULL || sDelayedWarpOp != WARP_OP_NONE) {\n        return;\n    }\n    for (n = gCurrentArea->warpNodes; n != NULL && n != &sS64WarpNode; n = n->next) {\n    }\n    if (n == NULL) {\n        sS64WarpNode.next = gCurrentArea->warpNodes;\n        gCurrentArea->warpNodes = &sS64WarpNode;\n    }\n    sS64WarpNode.node.id = 0xEF;\n    sS64WarpNode.node.destLevel = level;\n    sS64WarpNode.node.destArea = area;\n    sS64WarpNode.node.destNode = node;\n    sS64WarpNode.object = NULL;\n    sSourceWarpNodeId = 0xEF;\n    sDelayedWarpOp = WARP_OP_TELEPORT;\n    sDelayedWarpTimer = 20;\n    sDelayedWarpArg = 0;\n    play_transition(WARP_TRANSITION_FADE_INTO_COLOR, 0x14, 0xFF, 0xFF, 0xFF);\n}\n\nvoid initiate_warp(s16 destLevel, s16 destArea, s16 destWarpNode, s32 arg3) {\n',
  },
);

// the save file (s64_save.c): each file's backup slot keeps the story's progress and the keys; the
// game-over reload takes the file as last saved from RAM
PATCHES.push(
  {
    file: 'src/game/save_file.c',
    find: '#include "save_file.h"\n',
    replace: '#include "save_file.h"\n\nvoid s64_save_file_loaded(s32 file, struct SaveFile *main);\nvoid s64_save_file_saved(s32 file, struct SaveFile *main, struct SaveFile *progress);\nvoid s64_save_file_erased(s32 file, struct SaveFile *progress);\nvoid s64_save_file_reload(s32 file, struct SaveFile *main);\n',
  },
  {
    file: 'src/game/save_file.c',
    find: `        // Copy to backup slot
        bcopy(&gSaveBuffer.files[fileIndex][0], &gSaveBuffer.files[fileIndex][1],
              sizeof(gSaveBuffer.files[fileIndex][1]));
`,
    replace: `        // Studio 64: the second slot keeps the progress
        s64_save_file_saved(fileIndex, &gSaveBuffer.files[fileIndex][0], &gSaveBuffer.files[fileIndex][1]);
`,
  },
  {
    file: 'src/game/save_file.c',
    find: '    bzero(&gSaveBuffer.files[fileIndex][0], sizeof(gSaveBuffer.files[fileIndex][0]));\n',
    replace: '    bzero(&gSaveBuffer.files[fileIndex][0], sizeof(gSaveBuffer.files[fileIndex][0]));\n    s64_save_file_erased(fileIndex, &gSaveBuffer.files[fileIndex][1]);\n',
  },
  {
    file: 'src/game/save_file.c',
    find: `    bcopy(&gSaveBuffer.files[srcFileIndex][0], &gSaveBuffer.files[destFileIndex][0],
          sizeof(gSaveBuffer.files[destFileIndex][0]));
`,
    replace: `    bcopy(gSaveBuffer.files[srcFileIndex], gSaveBuffer.files[destFileIndex], sizeof(gSaveBuffer.files[destFileIndex]));
`,
  },
  {
    file: 'src/game/save_file.c',
    find: `        validSlots = verify_save_block_signature(&gSaveBuffer.files[file][0], sizeof(gSaveBuffer.files[file][0]), SAVE_FILE_MAGIC);
        validSlots |= verify_save_block_signature(&gSaveBuffer.files[file][1], sizeof(gSaveBuffer.files[file][1]), SAVE_FILE_MAGIC) << 1;
        switch (validSlots) {
            case 0: // Neither copy is correct
                save_file_erase(file);
                break;
            case 1: // Slot 0 is correct and slot 1 is incorrect
                restore_save_file_data(file, 0);
                break;
            case 2: // Slot 1 is correct and slot 0 is incorrect
                restore_save_file_data(file, 1);
                break;
        }
`,
    replace: `        // Studio 64: the second slot is the progress (a save of the original game: its copy)
        validSlots = verify_save_block_signature(&gSaveBuffer.files[file][0], sizeof(gSaveBuffer.files[file][0]), SAVE_FILE_MAGIC);
        if (!validSlots) {
            if (verify_save_block_signature(&gSaveBuffer.files[file][1], sizeof(gSaveBuffer.files[file][1]), SAVE_FILE_MAGIC)) {
                bcopy(&gSaveBuffer.files[file][1], &gSaveBuffer.files[file][0], sizeof(gSaveBuffer.files[file][0]));
                bzero(&gSaveBuffer.files[file][1], sizeof(gSaveBuffer.files[file][1]));
            } else {
                save_file_erase(file);
            }
        }
        s64_save_file_loaded(file, &gSaveBuffer.files[file][0]);
`,
  },
  {
    file: 'src/game/save_file.c',
    find: `    bcopy(&gSaveBuffer.files[gCurrSaveFileNum - 1][1], &gSaveBuffer.files[gCurrSaveFileNum - 1][0],
          sizeof(gSaveBuffer.files[gCurrSaveFileNum - 1][0]));
`,
    replace: `    s64_save_file_reload(gCurrSaveFileNum - 1, &gSaveBuffer.files[gCurrSaveFileNum - 1][0]);
`,
  },
);

// the engine's older decomp named some fields otherwise: both names (its modules use the old ones)
PATCHES.push(
  {
    file: 'include/types.h',
    find: `    /*0x02*/ s16 animYTransDivisor;
    /*0x04*/ s16 startFrame;
    /*0x06*/ s16 loopStart;
    /*0x08*/ s16 loopEnd;
    /*0x0A*/ s16 unusedBoneCount;`,
    replace: `    /*0x02*/ union { s16 animYTransDivisor; s16 unk02; }; // (Studio 64: the older names too)
    /*0x04*/ union { s16 startFrame; s16 unk04; };
    /*0x06*/ union { s16 loopStart; s16 unk06; };
    /*0x08*/ union { s16 loopEnd; s16 unk08; };
    /*0x0A*/ union { s16 unusedBoneCount; s16 unk0A; };`,
  },
  { file: 'include/types.h', find: '    /*0x38*/ struct AnimInfo animInfo;\n', replace: '    /*0x38*/ union { struct AnimInfo animInfo; struct AnimInfo unk38; }; // (Studio 64: the older name too)\n' },
);

// Studio 64's modules (overlays.js): the game's link keeps its relocations (where it points at a module
// is filled in when the module loads), and the modules' data in RAM passes as it is where the game
// takes segmented addresses
PATCHES.push(
  {
    file: 'Makefile',
    find: ' -Map $(BUILD_DIR)/sm64.$(VERSION).map --no-check-sections $(addprefix -R ,$(SEG_FILES))',
    replace: ' -Map $(BUILD_DIR)/sm64.$(VERSION).map --no-check-sections --emit-relocs $(addprefix -R ,$(SEG_FILES))',
  },
  // a level starts in new memory: the last one's modules are gone (s64_ovl.c)
  { file: 'src/engine/level_script.c', find: '    clear_areas();\n    main_pool_push_state();\n', replace: '    clear_areas();\n    s64_ovl_reset();\n    main_pool_push_state();\n' },
  { file: 'src/engine/level_script.c', find: '#include "level_script.h"\n', replace: '#include "level_script.h"\n#include "s64/s64_hack.h"\n' },
  {
    file: 'src/game/memory.c',
    find: `    size_t segment = (uintptr_t) addr >> 24;
    size_t offset = (uintptr_t) addr & 0x00FFFFFF;

    return (void *) ((sSegmentTable[segment] + offset) | 0x80000000);`,
    replace: `    size_t segment = (uintptr_t) addr >> 24;
    size_t offset = (uintptr_t) addr & 0x00FFFFFF;

    if (segment >= 0x80) { // Studio 64: RAM (its modules' data)
        return (void *) addr;
    }
    return (void *) ((sSegmentTable[segment] + offset) | 0x80000000);`,
  },
);

// Studio 64's modules in the game (overlays.js: the calls are trampolines, nothing while the level
// does not have the module): Shotgun Mario, Katana Mario and the cars in Mario's step, the camera,
// his body (the weapons in his hands) and the HUD
PATCHES.push(
  {
    file: 'src/game/mario.c',
    find: `        // If Mario is OOB, stop executing actions.
        if (gMarioState->floor == NULL) {
            return 0;
        }

        // The function can loop through many action shifts in one frame,
        // which can lead to unexpected sub-frame behavior. Could potentially hang
        // if a loop of actions were found, but there has not been a situation found.
        while (inLoop) {
            switch (gMarioState->action & ACT_GROUP_MASK) {`,
    replace: `        // If Mario is OOB, stop executing actions.
        if (gMarioState->floor == NULL) {
            return 0;
        }

        // Studio 64: Shotgun Mario, B at a car's door, Katana Mario (B pulls the blade or cuts)
        studio_shotgun_before_step(gMarioState);
        studio_vehicle_before_step(gMarioState);
        studio_katana_before_step(gMarioState);

        // The function can loop through many action shifts in one frame,
        // which can lead to unexpected sub-frame behavior. Could potentially hang
        // if a loop of actions were found, but there has not been a situation found.
        while (inLoop) {
            if (gMarioState->action == ACT_STUDIO_DRIVE) { // Studio 64: driving
                inLoop = studio_vehicle_action(gMarioState);
                continue;
            }
            if (ACT_KT_IS(gMarioState->action)) { // Studio 64: Katana Mario's moves
                inLoop = studio_katana_action(gMarioState);
                continue;
            }
            switch (gMarioState->action & ACT_GROUP_MASK) {`,
  },
  {
    file: 'src/game/mario.c',
    find: '        sink_mario_in_quicksand(gMarioState);\n        squish_mario_model(gMarioState);\n',
    replace: '        studio_shotgun_after_step(gMarioState);\n        studio_katana_after_step(gMarioState);\n        sink_mario_in_quicksand(gMarioState);\n        squish_mario_model(gMarioState);\n',
  },
  {
    file: 'src/game/mario.c',
    find: '#include "mario.h"\n',
    replace: `#include "mario.h"

// Studio 64's modules (s64_ovl_hooks.c)
void studio_shotgun_before_step(struct MarioState *m);
void studio_shotgun_after_step(struct MarioState *m);
void studio_vehicle_before_step(struct MarioState *m);
s32 studio_vehicle_action(struct MarioState *m);
void studio_katana_before_step(struct MarioState *m);
s32 studio_katana_action(struct MarioState *m);
void studio_katana_after_step(struct MarioState *m);
#define ACT_STUDIO_DRIVE (0x17A | ACT_FLAG_RIDING_SHELL | ACT_FLAG_INVULNERABLE | ACT_FLAG_ATTACKING \\
                          | ACT_FLAG_PAUSE_EXIT | ACT_FLAG_WATER_OR_TEXT)
#define ACT_KT_IS(a) ((((a) & 0x1FF) >= 0x178 && ((a) & 0x1FF) <= 0x17E) && ((a) & 0x1FF) != 0x17A)
`,
  },
  {
    file: 'src/game/camera.c',
    find: '    // If not in a cutscene, do mode processing\n    if (c->cutscene == 0) {\n',
    replace: `    // If not in a cutscene, do mode processing
    if (c->cutscene == 0 && (studio_shotgun_camera(c) || studio_katana_camera(c))) {
        // Studio 64: the shotgun's aim camera placed it, or the katana's pull or finale
    } else if (c->cutscene == 0) {
`,
  },
  { file: 'src/game/camera.c', find: 's32 gCurrLevelArea = 0;\n', replace: 's32 studio_shotgun_camera(struct Camera *c);\ns32 studio_katana_camera(struct Camera *c);\ns32 studio_vehicle_camera(f32 *pos, f32 *focus);\n\ns32 gCurrLevelArea = 0;\n' },
  {
    file: 'src/game/hud.c',
    find: '            render_hud_timer();\n        }\n    }\n}\n',
    replace: '            render_hud_timer();\n        }\n\n        studio_shotgun_hud(); // Studio 64: the shotgun\'s crosshair in aim mode\n    }\n}\n',
  },
  { file: 'src/game/hud.c', find: '#include "studio/objects.h"\n', replace: '#include "studio/objects.h"\n\nvoid studio_shotgun_hud(void);\nvoid s64_vehicle_hud(void);\n' },
  {
    file: 'src/game/rendering_graph_node.c',
    find: `        rotation[2] = gCurrAnimData[retrieve_animation_index(gCurrAnimFrame, &gCurrAnimAttribute)];
    }
    mtxf_rotate_xyz_and_translate(matrix, translation, rotation);
    mtxf_mul(gMatStack[gMatStackIndex + 1], matrix, gMatStack[gMatStackIndex]);
    gMatStackIndex++;
    mtxf_to_mtx(matrixPtr, gMatStack[gMatStackIndex]);
    gMatStackFixed[gMatStackIndex] = matrixPtr;
`,
    replace: `        rotation[2] = gCurrAnimData[retrieve_animation_index(gCurrAnimFrame, &gCurrAnimAttribute)];
        if (gStudioShotgunDraw) {
            studio_shotgun_anim_part(rotation); // Studio 64: Mario's arms hold the shotgun
        }
        if (gStudioKatanaDraw) {
            studio_katana_anim_part(rotation); // ... or the katana
        }
    }
    mtxf_rotate_xyz_and_translate(matrix, translation, rotation);
    mtxf_mul(gMatStack[gMatStackIndex + 1], matrix, gMatStack[gMatStackIndex]);
    gMatStackIndex++;
    mtxf_to_mtx(matrixPtr, gMatStack[gMatStackIndex]);
    gMatStackFixed[gMatStackIndex] = matrixPtr;
    if (gStudioShotgunDraw) {
        studio_shotgun_part_drawn(&gMatStack[gMatStackIndex]); // (the gun on his torso, its effects)
    }
    if (gStudioKatanaDraw) {
        studio_katana_part_drawn(&gMatStack[gMatStackIndex]); // (the blade in his right fist, its effects)
    }
`,
  },
  {
    file: 'src/game/rendering_graph_node.c',
    find: `/**
 * Process the master list node.
 */`,
    replace: `// Studio 64: a display list drawn with the current matrix (its modules' weapons and effects)
void studio_geo_append(void *displayList, s16 layer) {
    geo_append_display_list(displayList, layer);
}

// Studio 64: Mario carries the shotgun or the katana (their modules set these; s64_glue.c)
extern s32 gStudioShotgunDraw, gStudioKatanaDraw;
void studio_shotgun_anim_part(s16 *rotation);
void studio_shotgun_part_drawn(Mat4 *mtx);
void studio_katana_anim_part(s16 *rotation);
void studio_katana_part_drawn(Mat4 *mtx);

/**
 * Process the master list node.
 */`,
  },
);

// the engine's Studio 64 code: an area is loaded, a frame begins
PATCHES.push(
  { file: 'src/game/area.c', find: '#include "level_table.h"\n', replace: '#include "level_table.h"\n#include "s64/s64_hack.h"\n' },
  {
    file: 'src/game/area.c',
    find: '        load_obj_warp_nodes();\n        geo_call_global_function_nodes(&gCurrentArea->unk04->node, GEO_CONTEXT_AREA_LOAD);\n',
    replace: '        load_obj_warp_nodes();\n        geo_call_global_function_nodes(&gCurrentArea->unk04->node, GEO_CONTEXT_AREA_LOAD);\n        s64_area_loaded();\n',
  },
  { file: 'src/game/game_init.c', find: '        addr = level_script_execute(addr);\n', replace: '        s64_frame();\n        addr = level_script_execute(addr);\n' },
);

// the hooks that read the info
PATCHES.push(
  { file: 'src/game/memory.c', find: 'static void dma_read(u8 *dest, u8 *srcStart, u8 *srcEnd) {', replace: 'void dma_read(u8 *dest, u8 *srcStart, u8 *srcEnd) { // (Studio 64: also used by s64_hack.c)' },
  {
    file: 'src/game/game_init.c',
    find: '    load_segment_decompress(2, _segment2_mio0SegmentRomStart, _segment2_mio0SegmentRomEnd);\n',
    replace: '    load_segment_decompress(2, _segment2_mio0SegmentRomStart, _segment2_mio0SegmentRomEnd);\n    s64_load_info();\n',
  },
  { file: 'src/game/game_init.c', find: '#include "segment2.h"\n', replace: '#include "segment2.h"\n#include "s64/s64_hack.h"\n' },
  {
    file: 'levels/menu/script.c',
    find: '    SET_REG(/*value*/ LEVEL_CASTLE_GROUNDS),\n',
    replace: '    CALL(/*arg*/ LEVEL_CASTLE_GROUNDS, /*func*/ s64_start_level),\n',
  },
  { file: 'levels/menu/script.c', find: '#include "game/level_update.h"\n', replace: '#include "game/level_update.h"\n#include "s64/s64_hack.h"\n' },
  { file: 'src/game/level_update.c', find: '#include "level_update.h"\n', replace: '#include "level_update.h"\n#include "s64/s64_hack.h"\n' },
  {
    file: 'src/game/level_update.c',
    find: `                    if (save_file_exists(gCurrSaveFileNum - 1)) {
                        set_mario_action(gMarioState, ACT_IDLE, 0);
                    } else {
                        set_mario_action(gMarioState, ACT_INTRO_CUTSCENE, 0);`,
    replace: `                    if (save_file_exists(gCurrSaveFileNum - 1) || s64_skip_intro()) {
                        set_mario_action(gMarioState, ACT_IDLE, 0);
                    } else {
                        set_mario_action(gMarioState, ACT_INTRO_CUTSCENE, 0);`,
  },
  {
    file: 'src/game/level_update.c',
    find: '            initiate_warp(LEVEL_CASTLE, 1, 0x1F, 0);\n',
    replace: `            if (s64_info_valid() && gS64Info.exitLevel > 0) {
                initiate_warp(gS64Info.exitLevel, gS64Info.exitArea, gS64Info.exitNode, 0);
            } else {
                initiate_warp(LEVEL_CASTLE, 1, 0x1F, 0);
            }
`,
  },
  {
    file: 'src/game/camera.c',
    find: '    if (sCameraTriggers[level] != NULL) {\n        b = 0;\n',
    replace: '    if (sCameraTriggers[level] != NULL && !s64_is_custom_level(level)) {\n        b = 0;\n',
  },
  { file: 'src/game/camera.c', find: 's32 gCurrLevelArea = 0;\n', replace: 's32 s64_is_custom_level(s32 level);\n\ns32 gCurrLevelArea = 0;\n' },
  // the hack's levels have none of the original levels' camera special cases (their areas match no case)
  {
    file: 'src/game/camera.c',
    find: '    gCurrLevelArea = gCurrLevelNum * 16 + gCurrentArea->index;\n',
    replace: '    gCurrLevelArea = s64_is_custom_level(gCurrLevelNum) ? 0 : gCurrLevelNum * 16 + gCurrentArea->index;\n',
    all: true,
  },
  {
    file: 'src/audio/external.c',
    find: '    if (sBackgroundMusicForDynamics != sLevelDynamics[gCurrLevelNum][0]) {\n',
    replace: '    if (s64_is_custom_level(gCurrLevelNum) || sBackgroundMusicForDynamics != sLevelDynamics[gCurrLevelNum][0]) {\n',
  },
  { file: 'src/audio/external.c', find: 's16 *sLevelDynamics[LEVEL_COUNT] = {', replace: 's32 s64_is_custom_level(s32 level);\n\ns16 *sLevelDynamics[LEVEL_COUNT] = {' },
);

// a file's contents: text, or bytes ("base64:...")
const contents = (v) => (v.startsWith('base64:') ? Buffer.from(v.slice(7), 'base64') : Buffer.from(v, 'utf8'));

export function applyPatches(root) {
  for (const [rel, text] of Object.entries(FILES)) {
    const file = path.join(root, rel);
    try { if (fs.readFileSync(file).equals(contents(text))) continue; } catch { /* new */ }
    try { fs.unlinkSync(file); } catch {}
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents(text));
  }
  for (const p of PATCHES) {
    const file = path.join(root, p.file);
    const s = fs.readFileSync(file, 'utf8');
    if (s.includes(p.replace)) continue; // already applied
    if (!s.includes(p.find)) throw new Error(`the decomp source has changed: cannot patch ${p.file}`);
    try { fs.unlinkSync(file); } catch {}
    fs.writeFileSync(file, p.all ? s.split(p.find).join(p.replace) : s.replace(p.find, p.replace));
  }
}

// A source tree brought up to date from a pristine copy of the decomp: every file the changes
// touch is rebuilt from its pristine version and written only when it differs (make then rebuilds
// only what changed). For working on the ROM's code (tools/romkit_dev.mjs).
export function syncTree(root, pristine) {
  const want = new Map();
  const read = (rel) => (want.has(rel) ? want.get(rel) : fs.readFileSync(path.join(pristine, rel), 'utf8'));
  for (const p of PATCHES) {
    const s = read(p.file);
    if (!s.includes(p.find)) throw new Error(`the decomp source has changed: cannot patch ${p.file}`);
    want.set(p.file, p.all ? s.split(p.find).join(p.replace) : s.replace(p.find, p.replace));
  }
  for (const [rel, text] of Object.entries(FILES)) want.set(rel, text);
  const changed = [];
  for (const [rel, text] of want) {
    const file = path.join(root, rel);
    let now = null;
    try { now = fs.readFileSync(file); } catch { /* new */ }
    if (now && now.equals(contents(text))) continue;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try { fs.unlinkSync(file); } catch {}
    fs.writeFileSync(file, contents(text));
    changed.push(rel);
  }
  // files of ours that are gone
  const s64 = path.join(root, 'src', 's64');
  if (fs.existsSync(s64)) for (const f of fs.readdirSync(s64)) if (!want.has(`src/s64/${f}`)) { fs.rmSync(path.join(s64, f)); changed.push(`src/s64/${f} (removed)`); }
  return changed;
}

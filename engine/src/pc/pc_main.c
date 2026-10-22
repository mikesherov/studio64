#include <stdlib.h>
#include <stdio.h>

#ifdef TARGET_WEB
#include <emscripten.h>
#include <emscripten/html5.h>
#endif

#include "sm64.h"

#include "game/memory.h"
#include "audio/external.h"

#include "gfx/gfx_pc.h"

#include "gfx/gfx_opengl.h"
#include "gfx/gfx_direct3d11.h"
#include "gfx/gfx_direct3d12.h"

#include "gfx/gfx_dxgi.h"
#include "gfx/gfx_sdl.h"

#include "audio/audio_api.h"
#include "audio/audio_sdl.h"
#include "audio/audio_null.h"

#include "pc_main.h"
#include "studio/studio.h"
#include "cliopts.h"
#include "configfile.h"
#include "controller/controller_api.h"
#include "controller/controller_keyboard.h"
#include "fs/fs.h"

#include "game/game_init.h"
#include "game/main.h"
#include "game/thread6.h"

#ifdef DISCORDRPC
#include "pc/discord/discordrpc.h"
#endif

OSMesg D_80339BEC;
OSMesgQueue gSIEventMesgQueue;

s8 gResetTimer;
s8 D_8032C648;
s8 gDebugLevelSelect;
s8 gShowProfiler;
s8 gShowDebugText;

s32 gRumblePakPfs;
struct RumbleData gRumbleDataQueue[3];
struct StructSH8031D9B0 gCurrRumbleSettings;

static struct AudioAPI *audio_api;
static struct GfxWindowManagerAPI *wm_api;
static struct GfxRenderingAPI *rendering_api;

extern void gfx_run(Gfx *commands);
extern void thread5_game_loop(void *arg);
extern void create_next_audio_buffer(s16 *samples, u32 num_samples);
#ifdef AAPI_SDL2
void audio_sdl_set_paused(bool paused);
#endif
void game_loop_one_iteration(void);

void dispatch_audio_sptask(struct SPTask *spTask) {
}

void set_vblank_handler(s32 index, struct VblankHandler *handler, OSMesgQueue *queue, OSMesg *msg) {
}

static bool inited = false;

#include "game/display.h" // for gGlobalTimer
void send_display_list(struct SPTask *spTask) {
    if (!inited) return;
    gfx_run((Gfx *)spTask->task.t.data_ptr);
}

#ifdef VERSION_EU
#define SAMPLES_HIGH 656
#define SAMPLES_LOW 640
#else
#define SAMPLES_HIGH 544
#define SAMPLES_LOW 528
#endif

void produce_one_frame(void) {
    s32 resuming = FALSE;
    gfx_start_frame();

    const f32 master_mod = (f32)configMasterVolume / 127.0f;
    set_sequence_player_volume(SEQ_PLAYER_LEVEL, (f32)configMusicVolume / 127.0f * master_mod);
    set_sequence_player_volume(SEQ_PLAYER_SFX, (f32)configSfxVolume / 127.0f * master_mod);
    set_sequence_player_volume(SEQ_PLAYER_ENV, (f32)configEnvVolume / 127.0f * master_mod);

    studio_frame();
    game_loop_one_iteration();
    thread6_rumble_loop(NULL);

    // build mode is silent: the device pauses and no audio is made, so the music
    // stops where it was and goes on from there (the star select screen still plays)
    {
        extern s32 gStudioPaused, gStudioInIntro, gStudioAudioHold;
        static s32 sMuted;
        s32 mute = gStudioPaused && !gStudioInIntro && !gStudioAudioHold;
        if (mute != sMuted) {
            sMuted = mute;
#ifdef AAPI_SDL2
            // muting stops the device now; unmuting waits until the queue is refilled below
            if (mute) {
                audio_sdl_set_paused(TRUE);
            } else {
                resuming = TRUE;
            }
#endif
        }
        if (mute) {
            gfx_end_frame();
            studio_after_frame();
            return;
        }
    }

    {
        // the audio tap (studio/debug.c, frame-exact recordings): exactly one frame of sound
        // (544 + 528 samples, a real-time run's average) into the tap, nothing to the speakers
        extern s32 gStudioAudioTap;
        extern void studio_audio_tap_add(const s16 *samples, s32 count);
        if (gStudioAudioTap) {
            s16 tap_buffer[SAMPLES_HIGH * 2];
            static s32 sTapOdd;
            for (int i = 0; i < 2; i++) {
                u32 n = (sTapOdd ^ i) ? SAMPLES_LOW : SAMPLES_HIGH;
                create_next_audio_buffer(tap_buffer, n);
                studio_audio_tap_add(tap_buffer, n * 2);
            }
            sTapOdd ^= 1;
            gfx_end_frame();
            studio_after_frame();
            return;
        }
    }

    int samples_left = audio_api->buffered();
    u32 num_audio_samples = samples_left < audio_api->get_desired_buffered() ? SAMPLES_HIGH : SAMPLES_LOW;
    studio_audio_stats(samples_left);
    //printf("Audio samples: %d %u\n", samples_left, num_audio_samples);
    // after slow frames the queue is low: synthesize a chunk or two more to refill it
    // (the rate nudge above alone would take seconds, crackling all the while)
    int chunks = resuming || samples_left < 600 ? 4 : samples_left < audio_api->get_desired_buffered() / 2 ? 3 : 2;
    s16 audio_buffer[SAMPLES_HIGH * 2 * 4];
    for (int i = 0; i < chunks; i++) {
        /*if (audio_cnt-- == 0) {
            audio_cnt = 2;
        }
        u32 num_audio_samples = audio_cnt < 2 ? 528 : 544;*/
        create_next_audio_buffer(audio_buffer + i * (num_audio_samples * 2), num_audio_samples);
        studio_audio_level(audio_buffer + i * (num_audio_samples * 2), num_audio_samples * 2);
    }
    //printf("Audio samples before submitting: %d\n", audio_api->buffered());

    audio_api->play((u8 *)audio_buffer, chunks * num_audio_samples * 4);
#ifdef AAPI_SDL2
    if (resuming) {
        audio_sdl_set_paused(FALSE); // back from build mode with a full queue
    }
#endif

    gfx_end_frame();
    studio_after_frame();
}

void audio_shutdown(void) {
    if (audio_api) {
        if (audio_api->shutdown) audio_api->shutdown();
        audio_api = NULL;
    }
}

void game_deinit(void) {
#ifdef DISCORDRPC
    discord_shutdown();
#endif
    configfile_save(configfile_name());
    controller_shutdown();
    audio_shutdown();
    gfx_shutdown();
    inited = false;
}

void game_exit(void) {
    game_deinit();
#ifndef TARGET_WEB
    exit(0);
#endif
}

#ifdef TARGET_WEB
static EM_BOOL on_anim_frame(double time, UNUSED void *user) {
    static double target_time;

    time *= 0.03; // milliseconds to frame count (33.333 ms -> 1)

    if (time >= target_time + 10.0) {
        // We are lagging 10 frames behind, probably due to coming back after inactivity,
        // so reset, with a small margin to avoid potential jitter later.
        target_time = time - 0.010;
    }

    for (int i = 0; i < 2; i++) {
        // If refresh rate is 15 Hz or something we might need to generate two frames
        if (time >= target_time) {
            extern s32 studio_debug_gate(void); // studio/debug.c: frame advance, slow motion
            if (studio_debug_gate()) produce_one_frame();
            target_time = target_time + 1.0;
        }
    }

    return inited; // only continue if the init flag is still set
}
#endif

void main_func(void) {
    const char *gamedir = gCLIOpts.GameDir[0] ? gCLIOpts.GameDir : FS_BASEDIR;
    const char *userpath = gCLIOpts.SavePath[0] ? gCLIOpts.SavePath : sys_user_path();
    fs_init(sys_ropaths, gamedir, userpath);

    configfile_load(configfile_name());

    if (gCLIOpts.FullScreen == 1)
        configWindow.fullscreen = true;
    else if (gCLIOpts.FullScreen == 2)
        configWindow.fullscreen = false;

    const size_t poolsize = gCLIOpts.PoolSize ? gCLIOpts.PoolSize : DEFAULT_POOL_SIZE;
    u64 *pool = malloc(poolsize);
    if (!pool) sys_fatal("Could not alloc %u bytes for main pool.\n", poolsize);
    main_pool_init(pool, pool + poolsize / sizeof(pool[0]));
    gEffectsMemoryPool = mem_pool_init(0x4000, MEMORY_POOL_LEFT);

    #if defined(WAPI_SDL1) || defined(WAPI_SDL2)
    wm_api = &gfx_sdl;
    #elif defined(WAPI_DXGI)
    wm_api = &gfx_dxgi;
    #else
    #error No window API!
    #endif

    #if defined(RAPI_D3D11)
    rendering_api = &gfx_direct3d11_api;
    # define RAPI_NAME "DirectX 11"
    #elif defined(RAPI_D3D12)
    rendering_api = &gfx_direct3d12_api;
    # define RAPI_NAME "DirectX 12"
    #elif defined(RAPI_GL) || defined(RAPI_GL_LEGACY)
    rendering_api = &gfx_opengl_api;
    # ifdef USE_GLES
    #  define RAPI_NAME "OpenGL ES"
    # else
    #  define RAPI_NAME "OpenGL"
    # endif
    #else
    #error No rendering API!
    #endif

    char window_title[96] =
    "Super Mario 64 EX (" RAPI_NAME ")"
    #ifdef NIGHTLY
    " nightly " GIT_HASH
    #endif
    ;

    gfx_init(wm_api, rendering_api, window_title);
    wm_api->set_keyboard_callbacks(keyboard_on_key_down, keyboard_on_key_up, keyboard_on_all_keys_up);

    #if defined(AAPI_SDL1) || defined(AAPI_SDL2)
    if (audio_api == NULL && audio_sdl.init()) 
        audio_api = &audio_sdl;
    #endif

    if (audio_api == NULL) {
        audio_api = &audio_null;
    }

    audio_init();
    sound_init();

    thread5_game_loop(NULL);

    inited = true;

#ifdef EXTERNAL_DATA
    // precache data if needed
    if (configPrecacheRes) {
        fprintf(stdout, "precaching data\n");
        fflush(stdout);
        gfx_precache_textures();
    }
#endif

#ifdef DISCORDRPC
    discord_init();
#endif

#ifdef TARGET_WEB
    emscripten_request_animation_frame_loop(on_anim_frame, NULL);
#else
    while (true) {
        wm_api->main_loop(produce_one_frame);
#ifdef DISCORDRPC
        discord_update_rich_presence();
#endif
    }
#endif
}

int main(int argc, char *argv[]) {
    parse_cli_opts(argc, argv);
    main_func();
    return 0;
}

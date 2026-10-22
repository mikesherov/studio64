// bowser_bomb.c.inc

// Studio 64: a bomb can be placed in any level, where the IDs of the explosion's models
// (Bowser's group) may belong to another model (0x66 is Lakitu in the castle grounds, a Chain
// Chomp in Bob-omb Battlefield): give the fireball and the smoke their own graph nodes.
struct GraphNode *studio_geo_node(const GeoLayout *geo);
extern const GeoLayout bowser_flames_geo[];
extern const GeoLayout bowser_impact_smoke_geo[];
static struct Object *bowser_bomb_spawn_part(struct Object *parent, s32 model, const BehaviorScript *bhv,
                                             const GeoLayout *geo) {
    struct Object *obj = spawn_object(parent, model, bhv);
    struct GraphNode *node = studio_geo_node(geo);
    if (obj != NULL && node != NULL) {
        obj->header.gfx.sharedChild = node;
    }
    return obj;
}

void bhv_bowser_bomb_loop(void) {
    if (obj_check_if_collided_with_object(o, gMarioObject) == 1) {
        o->oInteractStatus &= ~INT_STATUS_INTERACTED;
        spawn_object(o, MODEL_EXPLOSION, bhvExplosion);
        o->activeFlags = ACTIVE_FLAG_DEACTIVATED;
    }

    if (o->oInteractStatus & INT_STATUS_HIT_MINE)
    {
        bowser_bomb_spawn_part(o, MODEL_BOWSER_FLAMES, bhvBowserBombExplosion, bowser_flames_geo);
        create_sound_spawner(SOUND_GENERAL_BOWSER_BOMB_EXPLOSION);
        set_camera_shake_from_point(SHAKE_POS_LARGE, o->oPosX, o->oPosY, o->oPosZ);
        o->activeFlags = ACTIVE_FLAG_DEACTIVATED;
    }

    set_object_visibility(o, 7000);
}

void bhv_bowser_bomb_explosion_loop(void) {
    struct Object *mineSmoke;

    cur_obj_scale((f32) o->oTimer / 14.0f * 9.0 + 1.0);
    if ((o->oTimer % 4 == 0) && (o->oTimer < 20)) {
        mineSmoke = bowser_bomb_spawn_part(o, MODEL_BOWSER_SMOKE, bhvBowserBombSmoke, bowser_impact_smoke_geo);
        mineSmoke->oPosX += random_float() * 600.0f - 400.0f;
        mineSmoke->oPosZ += random_float() * 600.0f - 400.0f;
        mineSmoke->oVelY += random_float() * 10.0f;
    }

    if (o->oTimer % 2 == 0)
        o->oAnimState++;
    if (o->oTimer == 28)
        o->activeFlags = ACTIVE_FLAG_DEACTIVATED;
}

void bhv_bowser_bomb_smoke_loop(void) {
    cur_obj_scale((f32) o->oTimer / 14.0f * 9.0 + 1.0);
    if (o->oTimer % 2 == 0)
        o->oAnimState++;

    o->oOpacity -= 10;
    if (o->oOpacity < 10)
        o->oOpacity = 0;

    o->oPosY += o->oVelY;

    if (o->oTimer == 28)
        o->activeFlags = ACTIVE_FLAG_DEACTIVATED;
}

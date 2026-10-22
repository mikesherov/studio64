#ifndef SURFACE_LOAD_H
#define SURFACE_LOAD_H

#include <PR/ultratypes.h>

#include "types.h"
#include "surface_collision.h"

struct SurfaceNode
{
    struct SurfaceNode *next;
    struct Surface *surface;
};

enum
{
    SPATIAL_PARTITION_FLOORS,
    SPATIAL_PARTITION_CEILS,
    SPATIAL_PARTITION_WALLS
};

typedef struct SurfaceNode SpatialPartitionCell[3];

// Needed for bs bss reordering memes.
extern s32 unused8038BE90;

extern SpatialPartitionCell gStaticSurfacePartition[NUM_CELLS][NUM_CELLS];
extern SpatialPartitionCell gDynamicSurfacePartition[NUM_CELLS][NUM_CELLS];
extern struct SurfaceNode *sSurfaceNodePool;
extern struct Surface *sSurfacePool;
extern s32 sSurfacePoolSize;

void alloc_surface_pools(void);

u32 get_area_terrain_size(s16 *data);

void load_area_terrain(s16 index, s16 *data, s8 *surfaceRooms, s16 *macroObjects);
void clear_dynamic_surfaces(void);
void load_object_collision_model(void);

void studio_load_object_collision(struct Object *obj);

#endif // SURFACE_LOAD_H

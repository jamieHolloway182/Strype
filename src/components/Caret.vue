<template>
    <div :class="{invisible: isInvisible && !areFramesDraggedOver, disabled: isPythonExecuting, 'caret-drop': areFramesDraggedOver, 'caret-drop-forbidden': areFramesDraggedOver && !areDropFramesAllowed}">
        <!-- The inner content of the caret is reserved for the cross (x) that is displayed during DnD when a location is forbidden for dropping -->
         <span v-if="!isInvisible && areFramesDraggedOver && !areDropFramesAllowed" class="caret-cross-forbidden-dnd caret-cross-forbidden-dnd-arm1"></span>
         <span v-if="!isInvisible && areFramesDraggedOver && !areDropFramesAllowed" class="caret-cross-forbidden-dnd caret-cross-forbidden-dnd-arm2"></span>
    </div>
</template>

<script lang="ts">

import Vue from "vue";
import { useStore } from "@/store/store";
import { mapStores } from "pinia";
import { PythonExecRunningState } from "@/types/types";

/**
 * Caret is used as a vertical cursor for browsing
 * throughout the code's frames and showing where
 * a frame will be droped when dragged.
 */

export default Vue.extend({
    name: "Caret",

    props: {
        isInvisible: Boolean,
        areFramesDraggedOver: Boolean,
        areDropFramesAllowed: Boolean,
    },

    computed:{
        ...mapStores(useStore),

        isPythonExecuting(): boolean {
            return (this.appStore.pythonExecRunningState ?? PythonExecRunningState.NotRunning) != PythonExecRunningState.NotRunning;
        },
    },
});
</script>

<style lang="scss">
.caret {
    width: $caret-width;
    background-color: #3467FE;
    border-radius: 6px;
    height: $caret-height-value + px;
    position: relative;
}

.caret.disabled {
    background-color: #b8bac0;
}

.caret-drop {
    background-color: #BB33FF !important;
}

.caret-drop-forbidden {
    background-color: #979799 !important;
}

.caret-cross-forbidden-dnd {
    display: block;
    width: 2px;
    height: $strype-frame-caret-forbidden-dnd-cross-height-notransform-value + px;
    background: red;
    position: absolute;
    z-index: 20;
}

.caret-cross-forbidden-dnd-arm1 {
    transform: translateY(((-$strype-frame-caret-forbidden-dnd-cross-height-notransform-value+$caret-height-value)/2) + px) rotate(-45deg) ;
    left: 50%;
}

.caret-cross-forbidden-dnd-arm2 {
    transform: translateY(((-$strype-frame-caret-forbidden-dnd-cross-height-notransform-value+$caret-height-value)/2) + px) rotate(45deg);
    left: 50%;
}

.invisible {
    background-color: transparent !important;
    height: 0px;
}
</style>

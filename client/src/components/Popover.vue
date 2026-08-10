<script setup>
/**
 * Popover — 鼠标悬停显示完整内容
 *
 * 用法：
 *   <Popover content="超长文案完整内容">
 *     <div class="truncated-text">超长文案…</div>
 *   </Popover>
 *
 * 或使用 #content slot 展示富文本：
 *   <Popover>
 *     <div class="truncated-text">…</div>
 *     <template #content>完整内容</template>
 *   </Popover>
 */
import { ref, onUnmounted, nextTick } from 'vue';

const props = defineProps({
  content:   { type: String,  default: '' },  // 简单文本内容
  disabled:  { type: Boolean, default: false },
  delay:     { type: Number,  default: 120 }, // 显示延迟 ms
  maxWidth:  { type: Number,  default: 280 },
});

const visible   = ref(false);
const pos       = ref({ top: '0px', left: '0px' });
const triggerEl = ref(null);
const popoverEl = ref(null);

let showTimer = null;

function show() {
  if (props.disabled) return;
  clearTimeout(showTimer);
  showTimer = setTimeout(async () => {
    visible.value = true;
    await nextTick();
    calcPos();
  }, props.delay);
}

function hide() {
  clearTimeout(showTimer);
  visible.value = false;
}

function calcPos() {
  if (!triggerEl.value || !popoverEl.value) return;
  const tr = triggerEl.value.getBoundingClientRect();
  const pr = popoverEl.value.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // 水平：优先居中对齐 trigger，但不超出视口
  let left = tr.left + tr.width / 2 - pr.width / 2;
  left = Math.max(8, Math.min(left, vw - pr.width - 8));

  // 垂直：优先上方，不够则下方
  let top = tr.top - pr.height - 8;
  if (top < 8) top = tr.bottom + 8;

  pos.value = { top: `${top}px`, left: `${left}px` };
}

onUnmounted(() => clearTimeout(showTimer));
</script>

<template>
  <div
    class="popover-wrap"
    ref="triggerEl"
    @mouseenter="show"
    @mouseleave="hide"
    @focusin="show"
    @focusout="hide"
  >
    <slot />

    <Teleport to="body">
      <Transition name="popover-fade">
        <div
          v-if="visible"
          ref="popoverEl"
          class="popover-box"
          :style="{ top: pos.top, left: pos.left, maxWidth: maxWidth + 'px' }"
          @mouseenter="show"
          @mouseleave="hide"
        >
          <slot name="content">{{ content }}</slot>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.popover-wrap { display: contents; }  /* 不影响父布局 */

.popover-box {
  position: fixed; z-index: 9998;
  background: #1e1e2c; color: #e0e0f0;
  border: 1px solid #2a2a3e; border-radius: 8px;
  padding: 8px 12px; font-size: 12px; line-height: 1.6;
  box-shadow: 0 8px 24px rgba(0,0,0,.45);
  pointer-events: none;  /* 避免触发 mouseleave */
  word-break: break-word;
}

/* 浅色模式 */
:global([data-theme="light"]) .popover-box {
  background: #fff; color: #1a1a2e;
  border-color: #d8d8e8; box-shadow: 0 8px 24px rgba(0,0,0,.12);
}

.popover-fade-enter-active, .popover-fade-leave-active {
  transition: opacity .12s, transform .12s;
}
.popover-fade-enter-from, .popover-fade-leave-to {
  opacity: 0; transform: translateY(4px);
}
</style>

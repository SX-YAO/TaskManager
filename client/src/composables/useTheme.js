import { ref, watch } from 'vue';

const STORAGE_KEY = 'task-manager-theme';
const theme = ref(localStorage.getItem(STORAGE_KEY) ?? 'dark');

// 写入 data-theme 属性，CSS 根据此切换变量
function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
}

applyTheme(theme.value);

watch(theme, (t) => {
  applyTheme(t);
  localStorage.setItem(STORAGE_KEY, t);
});

export function useTheme() {
  function toggle() {
    theme.value = theme.value === 'dark' ? 'light' : 'dark';
  }
  return { theme, toggle };
}

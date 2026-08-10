/**
 * 服务状态单例 —— 跨组件共享
 * http.js 在请求失败时调用 markOffline()
 * App.vue 消费 offline ref 控制断线遮罩
 */
import { ref } from 'vue';

export const offline = ref(false);

export function markOffline() {
  offline.value = true;
}

export function markOnline() {
  offline.value = false;
}

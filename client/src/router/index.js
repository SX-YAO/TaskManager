import { createRouter, createWebHistory } from 'vue-router';
import TaskList from '../pages/TaskList.vue';
import TaskDetail from '../pages/TaskDetail.vue';
import Settings from '../pages/Settings.vue';

export default createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/',          component: TaskList },
    { path: '/task/:id',  component: TaskDetail, props: true },
    { path: '/settings',  component: Settings },
  ],
});

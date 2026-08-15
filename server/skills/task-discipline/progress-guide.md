# 进度更新质量标准

task:progress 覆盖写 progress.json。pending 是重开会话后接力的命脉——
新会话只读 purpose / progress / pitfalls / conventions 恢复现场。

## pending 可接力颗粒度 checklist

每条 pending 必须包含：
1. 步骤名：一句话说清做什么
2. 关键文件路径：改哪里
3. 卡点 / 下一步具体动作：从哪继续

自检：一个没有任何对话历史的全新会话，只读这条 pending 能否直接动手？不能 → 重写。

## 示例

差：`pending="修复登录问题"`
好：`pending="修复 login 403：src/api/login.ts 的 token 刷新逻辑，卡在 refreshToken 未触发；改完跑 npm test"`

## 何时更新

- 完成一个里程碑 / 子任务后
- 方向调整、计划变更后
- 每轮结束前自问：progress.json 还反映现状吗？

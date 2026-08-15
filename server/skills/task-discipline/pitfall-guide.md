# 踩坑记录质量标准

task:pitfall 追加到 pitfalls.json。记录的价值在于让未来不再踩同一个坑。

## 五要素（融入 description / solution）

1. 现象：什么报错 / 异常行为
2. 根因：为什么会发生
3. 解决：怎么修的
4. 预防：下次如何避免
5. 关联文件：涉及哪些路径

## 写法

- description = 现象 + 根因 + 关联文件
- solution = 解决 + 预防
- type：error（实际踩坑）| lesson（经验总结）

## 何时记录

- 任何报错排查超过 5 分钟
- 发现文档 / 直觉与实际行为不符
- 用户纠正了你的做法（最重要的 lesson 来源）

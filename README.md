# Jeet的社媒工具

社媒发布工具：在插件自带的控制台里编辑纯文字、图文、视频，一次（或定时）发到 **小红书、Threads、X、TikTok、YouTube**。所有数据都只保存在当前浏览器里。
基于开源项目 [MultiPost](https://github.com/leaperone/MultiPost-Extension)（Apache-2.0）修改，修改内容见 [NOTICE](./NOTICE)。

## 安装（每台电脑一次）

1. 打开本仓库的 **Actions** 页 → 点最新一次成功的 “Build extension” → 页面底部 **Artifacts** 下载 `jeet-social-tool`，解压。
   （打了 `v` 开头的版本标签时，也可以在 **Releases** 里下载 zip。）
2. Chrome 地址栏打开 `chrome://extensions`，右上角打开 **开发者模式**。
3. 点 **加载已解压的扩展程序**，选择刚解压出来的文件夹（里面直接有 `manifest.json` 的那一层）。
4. 在这个 Chrome 里登录 X、TikTok、YouTube（Studio）。
5. 点工具栏上的插件图标，打开发布控制台。

更新：下载新版本解压后，覆盖原文件夹，再在 `chrome://extensions` 里点插件卡片上的刷新按钮。

## 使用要点

- 先选 **内容类型**：纯文字（Threads、X）、图文（小红书、Threads、X）、视频（全部 5 个平台）。
- 每个平台有独立文案框；各平台发一样的内容时，写在“通用文案”里点 **同步到所有平台**。
- 每个平台单独的 **自动发布** 开关：不勾时只打开发布页并填好内容，人工检查后手动点发布。
- 小红书标题 ≤20 字；YouTube 标题 ≤100 字，标签放在说明末尾。视频可选本地文件（不限大小）或 https 链接。
- 草稿库：新建、导入草稿 JSON（可带 `type`: text / image / video）、导出备份。
- **定时发布**：点“⏰ 定时发布”选时间，到点插件自动打开各平台并发布。要求到点时电脑开着（锁屏可以、不能睡眠）、这个 Chrome 开着、平台保持登录；晚 30 分钟以上的任务不会自动发，可在“定时任务”里立即补发。
- “平台设置”（选填）：隐藏用不到的平台、给这个浏览器起个名字显示在顶部。
- 发布时 **不要关闭控制台页面**，各平台标签页要从这里读取视频文件，等上传开始后再关。
- 草稿和发布记录保存在当前浏览器里，不会跨电脑同步。

## 合并原项目更新

平台改版导致填写失效时，先看原项目有没有修复：

```bash
git remote add upstream https://github.com/leaperone/MultiPost-Extension.git   # 只需一次
git fetch upstream
git merge upstream/main
```

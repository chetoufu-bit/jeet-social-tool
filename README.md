# Jeet的社媒工具

Card2Dream 内部用的社媒发布插件：一次编辑，发到 **X、TikTok、YouTube**。
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

- 默认 **只填好不发布**：插件打开各平台发布页并填好内容，人工检查后手动点发布。
- 标题只用于 YouTube（≤100 字）；标签在 YouTube 放在说明末尾，在 X / TikTok 跟在正文后。
- 发布时 **不要关闭控制台页面**，各平台标签页要从这里读取视频文件，等上传开始后再关。
- 草稿和发布记录保存在当前浏览器里，不会跨电脑同步。

## 合并原项目更新

平台改版导致填写失效时，先看原项目有没有修复：

```bash
git remote add upstream https://github.com/leaperone/MultiPost-Extension.git   # 只需一次
git fetch upstream
git merge upstream/main
```

## 网页版控制台

`gh-pages` 分支上的发布控制台网页：<https://chetoufu-bit.github.io/jeet-social-tool/>

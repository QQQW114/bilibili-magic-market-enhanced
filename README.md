# Bilibili 魔力赏市集搜索增强

脚本会在 B 站魔力赏/市集页面右上角注入一个搜索面板。

原官方 `/mall-magic-c/internet/c2c/v2/search` 接口在浏览器里会返回：

```text
请求错误，请稍后重试!
```

所以增强版使用原市集滚动加载的列表接口 `/mall-magic-c/internet/c2c/v2/list`，逐页扫描商品数据，然后在本地按关键词匹配。

## 功能

- **筛选已加载**：输入关键词后，隐藏当前页面已经加载出来但不匹配的商品卡片。
- **扫描搜索**：按市集列表接口逐页慢速扫描。
- **继续慢速扫描**：每次继续扫描一批页面，适合找较早发布的商品。
- **打开详情**：点击增强面板里的结果卡片会跳转到原商品详情页。
- **无需提供 token/cookie**：脚本运行在 `mall.bilibili.com` 页面里，会使用你浏览器自己的登录态。

## Chrome/Edge 扩展安装/更新

1. 打开：`chrome://extensions/` 或 `edge://extensions/`
2. 开启“开发者模式”。
3. 如果第一次安装，点“加载已解压的扩展程序”，选择：

```text
D:\bilibili-magic-market-enhanced\extension
```

4. 如果之前已经加载过这个扩展，请点该扩展卡片上的“重新加载”按钮，然后刷新商城页面。

可打开：

```text
https://mall.bilibili.com/neul-next/index.html?page=magic-market_index&noTitleBar=1
```

或搜索结果页：

```text
https://mall.bilibili.com/neul-next/index.html?page=magic-market_search-result&noTitleBar=1&keyword=初音&from=market_index
```

## Tampermonkey 备用脚本

导入：

```text
D:\bilibili-magic-market-enhanced\userscript\bilibili-magic-market-enhanced.user.js
```

## 其他
本项目为纯vibe coding产物，如有bug欢迎提交

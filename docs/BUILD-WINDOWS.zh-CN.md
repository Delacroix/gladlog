# 构建 Windows 安装包(`.exe`)

[English](BUILD-WINDOWS.md) · **中文**

Windows 的 **NSIS 安装包必须在 Windows 上构建**(macOS 跑 NSIS 要靠 Wine,已废弃)。
macOS 那边本来就会产出 x64 的 `.zip`,本文只讲安装包。配置全部已经提交进仓库,
不需要改任何东西。

## 前置条件(在 Windows 机器上)

- **Node.js ≥ 20.11**(构建用到 `import.meta.dirname`)。从
  https://nodejs.org 下载,LTS 安装包即可。
- **git**(https://git-scm.com)—— 只用来解包传过来的 bundle。

## 1. 拿到代码

你会拿到一个 `gladlog.bundle`(单文件、自包含的 git 包,不需要服务器)。
把它复制到 Windows 机器上,然后在终端(PowerShell 或 Git Bash)里:

```bash
git clone gladlog.bundle gladlog
cd gladlog
```

## 2. 安装依赖

```bash
npm ci
```

## 3. 构建安装包

```bash
npm -w @gladlog/desktop run package:win
```

这条命令先跑 `electron-vite build`,再跑 `electron-builder --win`;按仓库里
提交的配置,产出 **x64** 的 `nsis` 安装包和一个 `zip`。

## 4. 产物

产物在 `packages/desktop/dist-app/`:

- `gladlog.Setup.0.0.1.exe` —— 安装包。
- `gladlog-0.0.1-win.zip` —— 免安装版。

## 注意事项

- **未签名**:没有代码签名证书时,Windows SmartScreen 首次运行会告警
  (「更多信息」→「仍要运行」)。签名是可选的,需要买证书;有证书后在
  `build.win.certificateFile` / 环境变量里配上即可。
- 对照语料(`reference_vectors.json`)通过 `extraResources` 自动打进包里 ——
  打包后的应用里 compare 功能可用。
- 应用的日志分析功能是自包含的;**AI compare/分析需要运行时在应用设置里填你自己的
  Anthropic API key**。
- 如果还想把这台机器的日志实时推到你的 Mac,在这里跑 log-pipeline 的 streamer:
  `npm -w @gladlog/log-pipeline run stream -- --config stream.config.json`
  (配置文件格式见 `packages/log-pipeline`)。

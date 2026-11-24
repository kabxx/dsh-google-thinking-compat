# @kabxx/dsh-google-thinking-compat

面向 DeepSeek Harness（`0.2.2-rc.5`）的 Google 推理档位兼容插件，为 Google Gemini（`google-generative-ai`）与 Vertex（`google-vertex`）路由扩展 `xhigh` 和 `max` 思考档位。

- 在运行期内存中扩展「设置 → 模型」的 Gemini 推理档位列表至 `minimal / low / medium / high / xhigh / max` 并同步更新 8 种语言的校验提示，启用后即可在表单中直接添加并保存，停用或卸载自动还原（未开启 HMR 时请手动刷新页面）。
- 同时兼容自定义 Gemini API 路由、内置 `google` 与 `google-vertex` 路由：选择 `xhigh` / `max` 时向请求透传对应的 `"XHIGH"` / `"MAX"` `thinkingLevel`，普通档位（`minimal / low / medium / high`）与关闭思考（`off`）保持原生 `pi-ai` 行为。
- 启动时按档位探测上游支持情况，待上游原生支持后自动退让；若宿主 `@earendil-works/pi-ai` 不兼容会显式报错，不会单方面放行设置页表单。

## 安装

需要 Node.js `>= 24.9.0`：

```bash
dsh plugin --profile web add @kabxx/dsh-google-thinking-compat
```

也可在 DSH 插件管理器中选择「添加插件」并输入 `@kabxx/dsh-google-thinking-compat`（若使用其他配置档案，将 `--profile web` 替换为对应档案名）。本地调试源码时，直接填入克隆后的仓库目录绝对路径或执行 `dsh plugin --profile web add link:$(pwd)` 即可。

## 使用

1. 启用插件后进入 **「设置 → 模型」**，新建或「编辑」协议为 `Gemini API` 的 **「自定义模型 API」** 提供商。
2. 展开 **「自定义设置」** 与目标模型的 **「模型选项」**，开启 **「推理等级」**，点击 **「添加档位」** 依次加入 `xhigh` / `max` 并点击 **「保存」**（表单内档位名需与请求值一致；如需跨档位映射，请在 `cordis.patch.yml` 中配置）。
3. 回到聊天页，在输入框的模型选择器中切换为 `Xhigh` 或 `Max` 即可；请仅在目标模型与上游接口实际支持 `thinkingLevel` 时开启。
4. 内置目录的 `google` 或 `google-vertex` 路由可在 `cordis.patch.yml` 的 `llm-pi-ai` 配置中通过 `providers.<路由>.modelOverrides.<模型>.reasoningEfforts` 声明（该字段会整体替换可选档位，需一并列出要保留的档位；若路由已配 `models` 列表，则直接写在对应模型条目中）：

```yaml
providers:
  google: # 或 google-vertex
    modelOverrides:
      gemini-3.1-pro-preview:
        reasoningEfforts:
          low: low
          medium: medium
          high: high
          xhigh: xhigh
          max: max
```

## 开发

运行语法检查与测试（可选设置 `DSH_INSTALL_DIR` 指向本机 `@deepseek-ai/dsh` 安装目录以验证真实宿主包）：

```bash
export DSH_INSTALL_DIR="$(npm root -g)/@deepseek-ai/dsh"
npm run check
npm test
npm pack --dry-run
```

## 项目结构

| 路径 | 内容 |
| --- | --- |
| [`src/index.js`](src/index.js) | 插件入口与生命周期装配 |
| [`src/pi-ai-thinking.js`](src/pi-ai-thinking.js) | `@earendil-works/pi-ai` 运行期探测与 `thinkingLevel` 透传钩子 |
| [`src/settings-ui.js`](src/settings-ui.js) | `clientModules` 内存级 `ui-settings-models` 扩展与还原 |
| [`locale/`](locale/) | 插件管理页中英文标题与描述 |
| [`test/`](test/) | 单元测试与包清单约束校验 |

插件入口与注入配置见 [package.json](package.json) 和 [cordis.patch.yml](cordis.patch.yml)，开源许可见 [LICENSE](LICENSE)。

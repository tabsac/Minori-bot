# Minori-bot

当前生产 Bot 的源码快照，包含本地图片/动图工具、群规则、全局图片帮助、ON 指令、ARK 指令，以及 Haruki / Sakura / Tsugu / Astrbot 的 OneBot v11 路由。

## 运行条件

Node.js、Python 3 与 Pillow；游戏资料查询工具可能需要额外 Python 库。使用 OneBot v11 网关。`npm install` 后 `npm start`，先按自己的环境修改 app.js 中端口、路径、机器人 QQ 和下游地址。

本仓库不是开箱即用的部署包。生产的主数据、图片素材、字体、游戏协议描述、编译工具与本地渲染资源需要另外准备；部分目录目前仍使用 `/home/admin/bot`、`/www/wwwroot/ournotes-web` 路径。帮助图片与 ON 图片使用 `data/on/b25-runtime/node_modules/@napi-rs/canvas`，可在该目录安装依赖或调整加载路径。字体读取正式网页的 `static-data/b25-font.ttf`。

## 配置与数据

环境变量示例见 `.env.example`，Node.js 可使用 `node --env-file=.env app.js`。原有认证常量已改读 `MINORI_AUTH` / `MINORI_AUTH_KEY`。不同工具使用的认证值可能不同，部署时应分别配置，不能直接共用生产凭据。

不包含生产密钥、QQ 登录态、游戏账号包、用户数据库、Cookie、缓存、游戏图片素材或服务器运维脚本。运行数据需由部署者自行提供，切勿提交到 Git。

## 主要入口

- `/help`：本地纯白文字帮助图，所有下游均不接收该指令。
- `/onhelp`、`/arkhelp`、`/banghelp`、`/pjskhelp`：功能帮助。
- `/修改规则`：按群设置默认前缀、接口优先/开关、动图处理方式。
- `/q弹`、`/弹跳`：静态图和动图处理。
- `/on打歌奖励`：根据上传账号的领取记录统计未领取金币和星石。

## 源码范围与许可

这是可审阅的源码快照，不包含旧 Git 历史。第三方引用文件保留自身版权头；本仓库暂未声明整体开源许可证，公开可见不等于授予任意再分发许可。网页独立项目仍单独维护；这里的共享渲染模块用于 Bot 输出。

## 公开源码隐私配置

QQ 黑名单默认空，通过 `BLOCK_QQS`（逗号分隔）设置。机器人 QQ 使用 `BOT_SELF_ID`，管理员使用 `ON_ADMIN`，不包含生产账号。Sakura 地址使用 `SAKURA_PJSK_URL` / `SAKURA_MAIMAI_URL` / `SAKURA_TAIKO_URL`，不填写则不连接。示例图片链接使用 example.invalid 占位。公开的游戏官方 API、上游源码地址及项目网页入口保留。

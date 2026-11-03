# 抢答星球 · 在线考试平台

一个**零依赖**的实时考试系统：管理端出题、发布考试、实时监控；用户端在线作答、整场倒计时、交卷后统一阅卷。
一个 Node 进程 + 两个 HTML 页面，`npm install` 都不需要，装好 Node 就能跑。

- 管理端 `/admin`：题库管理（分值、解析）、考试配置（时长、题目乱序、选项乱序、切屏上限、全交自动结束）、多场考试并行、实时监控、成绩统计与 CSV 导出
- 用户端 `/`：输名字进考场（不可改名）、整场倒计时、一次看到整卷、答题卡跳转、交卷、防切屏提示、考后成绩与逐题解析
- 多场考试可同时进行，各自独立计时与统计

---

## 一、本地运行（30 秒）

需要 Node.js 18+（<https://nodejs.org/>）。

```bash
# Windows：双击 start-windows.bat
# macOS / Linux：
./start.sh
# 或者
node server.js
```

打开：

- 用户端 <http://localhost:8095/>
- 管理端 <http://localhost:8095/admin>
- 默认管理密码：**admin123**（登录后到「设置」里改）

同一局域网内，把 `localhost` 换成电脑 IP，学生用手机就能访问。

---

## 二、部署成公开网站

> 这是**有状态服务**（登录、实时推送、判分都在服务端），
> GitHub Pages / Netlify 这类纯静态托管**跑不了**，必须用能跑 Node 的平台。

### 方案 A：Render（推荐，免费）

1. 把本目录推到一个 GitHub 仓库（新建仓库 → 上传这些文件）
2. 打开 <https://render.com> → New → **Web Service** → 连接该仓库
3. 填写：
   - Runtime：**Node**
   - Build Command：留空
   - Start Command：`node server.js`
   - Plan：Free
4. 点 Deploy，等 1~2 分钟，得到 `https://xxx.onrender.com`
5. 管理端：`https://xxx.onrender.com/admin`

仓库里带了 `render.yaml`，也可以在 Render 里选 **New → Blueprint** 直接读这个文件创建。

> 免费实例闲置一段时间会休眠，第一次打开要等十几秒；考试期间保持访问即可。

### 方案 B：Railway

1. 仓库推到 GitHub → <https://railway.app> → New Project → Deploy from GitHub repo
2. Railway 自动识别 Node，启动命令用 `npm start`（已在 package.json 里配置）
3. Settings → Networking → Generate Domain

### 方案 C：自己的服务器 / Docker

```bash
# 方式一：直接跑
scp -r . user@server:/opt/quiz-arena
ssh user@server 'cd /opt/quiz-arena && PORT=8095 node server.js'

# 方式二：Docker
docker build -t quiz-arena .
docker run -d -p 8095:8080 -v quizdata:/app/data --name quiz quiz-arena
```

Nginx 反代（**必须关缓冲**，否则实时推送会被卡住）：

```nginx
location / {
    proxy_pass http://127.0.0.1:8095;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header Connection '';
    proxy_buffering off;
    proxy_read_timeout 3600s;
}
```

### 方案 D：临时公网（不用注册，适合马上试）

```bash
node server.js
cloudflared tunnel --url http://localhost:8095
```

会打印一个 `https://xxx.trycloudflare.com` 地址，外网可访问；命令关掉就失效。

---

## 三、数据与持久化

- 题库、考试、成绩都存在 `data/db.json`（首次启动自动生成，并带 5 道示例题）
- 删除这个文件即可恢复出厂设置
- **进行中的考试在内存里**，服务重启会回到草稿，需要重新发布
- Render/Railway 免费实例的磁盘是临时的，**重新部署会丢数据**；要长期保存请挂载持久磁盘（Render: Disks；Docker: `-v quizdata:/app/data`），或定期下载 `data/db.json` 备份

---

## 四、环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | 8095 | 监听端口，云平台会自动注入 |

---

## 五、常见问题

**管理端打不开 / 一直在登录页**
先确认服务在跑：浏览器打开 `/api/public` 应该返回 JSON。服务没启动时页面是打不开的；
如果是从别的设备访问，检查防火墙是否放行端口。

**答题中途页面被刷新，会丢答案吗？**
不会。每题选择都会即时保存到服务端，刷新后凭同一浏览器的 token 自动恢复。

**能改成自己的题库吗？**
可以。管理端「题库」直接增删改；也可以编辑 `data/db.json`（格式见文件内示例）。

**多个班同时考试？**
可以同时发布多场考试，各自独立倒计时和成绩，互不影响。

---

## 六、目录结构

```
.
├── server.js            服务端（考试状态机、判分、SSE 推送、鉴权、导出）
├── public/
│   ├── index.html       用户端
│   └── admin.html       管理端
├── data/                运行后生成 db.json
├── package.json
├── Dockerfile
├── render.yaml
├── start.sh
└── start-windows.bat
```

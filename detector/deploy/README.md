# 检测服务容器发布

发布链路是 GitHub 提交 → 全量 CI → 构建实际镜像并隔离检查 → GHCR 和 GitHub Release → 服务器校验并切换。构建不在生产服务器执行。

## 发布产物

`.github/workflows/ci.yml` 的 `detector-image` 等待 Python 测试、平台检查和生产构建全部通过。在 PR 上只构建、检查；合并 main 后发布：

- `ghcr.io/nanashiwang/gewu-detector:<完整提交 SHA>`，部署实际绑定镜像 ID 和 registry digest，不使用 `latest`。
- GitHub Release `detector-<完整提交 SHA>`：`release.json`、`detector-image.tar.gz`、`container_release.py`。
- 新建 GHCR 包可能还没有匿名读取权限。服务器优先拉取 manifest 中的 digest；不可用时下载同一版本的公开 Release 镜像归档，验证 SHA256、镜像 ID、版本标签和架构后加载，无需把 GitHub token 放到服务器。

镜像限定 `linux/amd64`。构建上下文使用允许列表，运行镜像不包含 `.env`、API Key、历史报告、基线、字体私有目录或回滚备份。生产镜像带通用 Noto CJK 字体；服务器已有报告字体可以只读挂载。

## 服务器操作

先确认对应提交的 CI 和 `detector-<SHA>` Release 已发布，再用完整提交 SHA 替换下方变量。命令在服务器运行，无需从 Mac 上传文件：

```bash
GEWU_REVISION=替换为40位提交SHA
curl --fail --location --retry 2 --connect-timeout 15 --max-time 60 \
  "https://raw.githubusercontent.com/nanashiwang/gewu/${GEWU_REVISION}/detector/deploy/container_release.py" \
  -o "/tmp/gewu-container-${GEWU_REVISION}.py"
python3 "/tmp/gewu-container-${GEWU_REVISION}.py" preflight
python3 "/tmp/gewu-container-${GEWU_REVISION}.py" deploy "$GEWU_REVISION"
```

预检要求 Ubuntu/systemd、运行中的 Docker、x86_64、现有 `gewu` 账户及至少 1 GiB 可用空间。校验原服务活跃、目录没有符号链接、配置符合已有挂载路径。若出现自定义文件路径、额外 EnvironmentFile、旧 `src/data/baselines` 中有实际证据，脚本停止并要求先核对，不会自行搬迁数据。预检只显示状态与变量名称，不输出密钥值。

支持维护协议的新版本在切换前通过本机文件锁关闭新检测和模型探测的提交入口，已有任务继续运行，报告和取消入口仍可用。脚本同时等待排队任务、运行任务以及上游清理协程退出，且没有运行中的定时监测，才停止服务。默认等待 300 秒，可用 `--drain-timeout 0..1800` 调整；超时不停止服务、不取消任务，释放锁后继续接收提交。

首次从不支持维护协议的旧版升级时，必须显式加 `--bootstrap-drain`。这一次仍要求 10 分钟无新提交、无待执行任务的空闲窗口，**不能消除旧版最后一次检查后的提交竞争**；不声称旧版已进入维护。新版安装完成后，后续部署自动使用维护协议，不能用该参数绕过已支持协议的维护检查。原有中断任务恢复语义保持不变，不自动重跑、不会主动启动付费采样。

正式切换之前，镜像在无外网的临时容器中检查 readiness、首页、榜单来源、检测范围及 JPG 生成，再检查真实数据卷的读写权限。无论检查成功或失败，临时容器都必须清除。正式服务仍通过 `gewu.service` 管理：仅新增 `50-container.conf` override，systemd 负责启动 Docker，容器进程使用原 `gewu` UID/GID、只读根文件系统和最小权限。使用 host network，服务仍只监听 `127.0.0.1:8765`，无需修改 nginx。

`/etc/gewu.env` 仍由 systemd 解析，避免 Docker env-file 对引号和特殊字符的不同解释。仅以变量名称转交 `GEWU_*` 设置，值不会出现在启动命令或发布日志中；官方供应商 API Key 不注入 Web 容器。自定义文件路径先阻断，避免引用没有挂载的宿主机文件。

数据路径保持：

| 宿主机目录 | 容器权限 |
| --- | --- |
| `/opt/gewu-detector/web_data` | 读写，保留历史任务、报告和愿望清单 |
| `/opt/gewu-detector/data/baselines` | 只读，通过 `GEWU_BASELINES_DIR` 显式定位 |
| `/opt/gewu-detector/report_fonts`（存在时） | 只读 |

既有账号平台、其他 Docker 容器、nginx、私有配置和已存在报告会在切换前后核对；新增报告可以正常产生。保护清单只保存在服务器，不上传 GitHub。

本次迁移的是 Web 检测进程。宿主机源码、venv 以及 `gewu-monitor@` 定时任务保留，已有定时任务继续使用原宿主机版本；不会暗中切换其版本或触发采样。需要把定时任务也迁到镜像时，应单独处理它的 systemd credential 挂载和目标配置。

## 验收和回滚

成功输出包含：

```text
GEWU_LEFTOVER_TEST_CONTAINERS=0
DEPLOY_SUCCESS=<完整提交 SHA>
ROLLBACK_DIRECTORY=/opt/gewu-deploy-backups/container-<UTC时间>
```

容器版本记录在 `/opt/gewu-detector/.container-release.json`；宿主机 `.deployed-commit` 继续表示旧源码版本，避免误报宿主机代码已经更新。

切换失败会恢复原 override 和版本记录、重新启动上一版服务并验证 readiness。手动回滚：

```bash
python3 /tmp/gewu-container-<SHA>.py rollback /opt/gewu-deploy-backups/container-<UTC时间>
```

只恢复检测服务的 override 和容器状态，不覆盖报告、密钥或基线。保留旧宿主机安装，直到容器迁移完成真实运行验收；不要提前删除 venv。不得使用 `docker system prune`、`docker volume prune` 或对整个 `/opt` 的清理命令。

## 旧部署垃圾清理

仅在部署成功且当前服务健康后执行。先列清单：

```bash
python3 /tmp/gewu-container-<SHA>.py cleanup
```

确认自动规则匹配的内容后执行清理（两次扫描结果必须相同）：

```bash
python3 /tmp/gewu-container-<SHA>.py cleanup --apply
```

只允许删除 `/opt/gewu-deploy-staging` 中名称符合旧部署格式、具有有效版本 manifest、整个目录内文件都超过 30 天未使用的暂存目录；至少保留最近两份。跳过符号链接和包含报告、基线、venv、私有监测数据的目录。不删除任何回滚备份、历史镜像、其他项目资源或用户报告。没有符合条件的目录就清理 0 项。

清理前输出每一项路径、字节数和原因；清理后将记录保存在 `/opt/gewu-detector-releases/cleanup-<UTC时间>.json`，方便向维护者说明实际删了什么。

## Docker 镜像存储兼容性

发布端的 `image_id` 与服务器 Docker 的本地 `Id` 不一定相同：传统镜像存储与 containerd 镜像存储可能使用不同的内容摘要作为本地身份。脚本优先按不可变的仓库 digest 查找/拉取并核对 `RepoDigests`；匿名仓库拉取失败时，先验证 Release 归档 SHA256、加载归档，再解析该次加载的完整版本标签。已有的版本标签不能直接作为可信缓存。

两条路径都检查完整提交标签、镜像归属和 `linux/amd64` 平台，然后仅以验证过的本地内容 ID 启动容器。状态记录同时保留发布端 `image_id` 与服务器 `runtime_image_id`，不会修改 Release manifest 或放宽成 `latest` 部署。错误只显示操作名称和退出码/超时，不输出参数或环境值。

CI 在隔离 runner 上以 Docker 29.4.1 的两种镜像存储，对已发布的传统镜像执行真实 digest 拉取与归档回退测试；原有真实 systemd 切换和回滚演练继续保留。生产服务器不修改 Docker 配置，不重启 Docker daemon。

停止服务的外层等待预算为 150 秒，覆盖 systemd 对 ExecStop 与主进程终止各自的停止期限，避免回滚在 systemd 完成停止前提前报超时；不会延长容器本身的正常停止宽限。

## 共享服务器资源预算

仅为格物 Web 检测容器及它的临时检查容器设置 CPU、内存硬上限；不执行 `docker update`，不改 Docker daemon 或其他项目。默认 CPU 上限为 1 核与宿主机核数一半中的较小值。内存至少 512 MiB，并给当前格物容器可读取的历史内存峰值保留 50% 余量、向上取整到 64 MiB；自动预算不超过 1 GiB 或宿主机内存四分之一。宿主机可用内存不足 192 MiB、峰值无法读取或自动预算不足时，部署停止并要求先核对容量。

需要人工调整时使用 `--cpus` 和 `--memory-mib`；CPU 仍不得超过宿主机一半，内存不得超过宿主机一半且必须覆盖观测峰值及余量。内存与 memory-swap 上限设为相同值，避免检测容器额外占用共享 swap。阈值是共享主机的保守初始预算，不是全工作负载容量证明；CI 只证明隔离冒烟与 JPG 生成可在限额内完成，真实负载峰值在每次部署前读取。达到硬内存上限可能触发容器 OOM，原有中断状态保留且不自动重跑付费请求。

脚本打印 `RESOURCE_BUDGET`，切换前后检查 Docker 实际应用的限额和 OOM 状态，并在 `.container-release.json` 的 `resources` 记录本次配置。旧版回滚沿用旧配置，可能没有新限额。

## 维护锁与故障恢复

维护锁位于 `/opt/gewu-detector/web_data/.gewu-deployment.lock`，部署进程持有排他 flock，提交入口持有短期共享 flock；请求的校验、预检与任务登记均在共享锁内。没有公开的维护开关或新增网络监听端口。`/readyz` 仅增加协议、是否接收、待完成任务数量等只读状态，维护期间仍保持健康，避免 Docker 把正常排空误判为故障。

排他锁覆盖切换、健康检查和失败回滚，并由新旧容器共享同一挂载文件。脚本正常结束、等待超时、异常或被终止后，内核都会释放文件锁，避免持久维护标志造成永久停站；这不等于强制终止时会自动完成尚未执行的回滚。锁文件保留，禁止在运行时删除或替换。手动 rollback 也先经过维护等待。正式切换本身仍有短暂重启窗口，不宣称零停机。

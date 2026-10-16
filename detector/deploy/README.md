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

部署前必须有 10 分钟无新检测提交的空闲窗口，且没有 queued/running 任务或运行中的定时监测。第一次切换会短暂重启服务；空闲预检不能阻止检查后瞬间新到达的请求，仍应选择低流量窗口。原有中断任务恢复语义保持不变，不自动重跑、不会主动启动付费采样。

正式切换之前，镜像在无外网的临时容器中检查 readiness、首页、榜单来源、检测范围，再检查真实数据卷的读写权限。无论检查成功或失败，临时容器都必须清除。正式服务仍通过 `gewu.service` 管理：仅新增 `50-container.conf` override，systemd 负责启动 Docker，容器进程使用原 `gewu` UID/GID、只读根文件系统和最小权限。使用 host network，服务仍只监听 `127.0.0.1:8765`，无需修改 nginx。

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

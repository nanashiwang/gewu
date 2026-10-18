# 格物账号平台与检测站配套发布

GitHub CI 构建 Linux standalone 产物，使用固定 Node 基础镜像将其封装为账号平台运行镜像，再在隔离 runner 验证数据库副本、两份 Compose 配置、真实切换及失败回滚。服务器只拉取固定 digest 或校验过的归档，不安装依赖、不编译应用、不执行数据库迁移。

一次配套发布产生同提交的 `platform-<SHA>` 和 `detector-<SHA>` Release。使用 `platform-<SHA>` 中的 `container_release.py`，先核对该脚本 SHA256，再运行：

```bash
python3 container_release.py preflight
python3 container_release.py deploy <完整40位提交SHA>
```

该命令先更新 `gewu-app`，再调用同版本、经过哈希核对的检测部署脚本更新 `gewu-detector`。`gewu-relay-cron`、`gewu-postgres`、`gewu-redis` 和其他项目不重新创建。不会使用全局 prune，也不删除旧镜像、缓存、生产卷或已有备份。

预检读取当前容器的 Compose project、两个或多个配置文件、实际工作目录和有效环境，只有配置哈希与运行容器一致时继续。仅支持已有 `gewu-platform` 项目、`/opt/gewu-platform` 下的配置、唯一 `/app/media` 命名卷、同网络 PostgreSQL 16 的 `gewu` 数据库和已有 Redis。未知布局停止，不自动改环境。敏感值不打印，备份和冻结 Compose 文件以 root 0600 保存在服务器。

先创建 `pg_dump` 一致性备份，再将副本恢复到内部 Docker 网络中的临时 PostgreSQL。临时账号服务使用随机测试凭据与临时 Redis，无法连接外网、真实数据库或模型上游。检查新版本需要的列和枚举、报告入口鉴权、启动前后整个副本 schema/rows 的指纹。验证通过后移除本次创建的临时容器、网络和数据库副本，保留备份。机器须有至少 900 MiB available 内存、足够磁盘；超过 512 MiB 的数据库不走此轻量流程。

正式切换使用检测站已有维护锁，等待检测和定时任务空闲，Compose 只执行 `app --no-deps --no-build --pull never`。新旧账号容器核对环境、启动命令、挂载、网络、资源与日志参数；其他容器核对 ID/启动时间/状态；已有媒体和配置逐文件核对。数据库只检查 schema，不将并发合法业务写入当作待回滚数据。

失败时恢复旧账号镜像、原配置和旧版本记录，数据库和媒体均不恢复覆盖。若检测升级失败，只有确认检测已经回到原版本，才恢复账号镜像。状态不明时保留具备隐私保护的账号版本并要求核对。备份目录下保留精确恢复记录：

```bash
python3 container_release.py rollback /opt/gewu-platform/container-backups/<本次目录>
```

回滚前必须匹配当前发布记录、数据库 schema 和可恢复镜像。已经产生新私密账号报告时，回滚到不识别私密记录的旧账号版本会被拒绝，避免重新公开记录；应保留隐私版本并做向前修复。独立检测站部署仍可使用 detector Release。

成功标记：

```text
GEWU_PLATFORM_LEFTOVER_TEST_CONTAINERS=0
PAIR_DEPLOY_SUCCESS=<提交SHA>
ACCOUNT_ROLLBACK_DIRECTORY=<账号恢复记录>
DETECTOR_ROLLBACK_DIRECTORY=<检测恢复记录>
```

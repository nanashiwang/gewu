# 动态：公开资讯收录与每日同步

页面：`/updates`，主导航名称为“动态”。按用户指定范围收录最新一篇及其之前五篇，共六篇，保留分类、标题、简述、原文时间（北京时间）和原文链接。页面不显示聚合站名称与跳转入口；采集来源仍记录在本说明和同步程序中，不标注为格物原创。

## 实现选择

已有 `/leaderboard/sources` 展示厂商状态，`/leaderboard/monitor` 展示线路观测，均不能把资讯当成检测证据。动态使用独立页面与快照，不写入报告、评分或榜单，不改格物账号平台、卡台、酒馆的数据。

来源为 `https://www.zzstan.com/market` 公开 HTML 内的 `latestUpdates` 数据，解析 JSON 字符串，不执行来源脚本。开放 API 文档主要覆盖站点和分组，并未据此假设存在已授权的新闻接口。页面收录第三方资讯，不保证原文事实已独立核验。

当前来源公开首页只提供最新 10 篇。每天读取能保存当次可见条目；一天超过 10 篇或停机期间滚出列表的帖子可能遗漏，不能宣称是全量归档。后续如需补全，应接来源提供的分页或正式订阅接口。

## 数据与运行边界

- `web/data/updates.json` 是初始六篇公开快照，运行时状态存于现有 jobs 数据卷的 `.updates/snapshot.json`。
- 按来源 ID 更新与去重，保留最新 200 篇；标题更正覆盖同 ID 的旧内容。
- 原文 `posted_at` 必须自带时区，拒绝把含糊的采集时间当作发布时间。
- 访客请求只读本地数据，不触发抓取。来源链接不携带用户的 Key、检测目标或报告。
- 同步进程使用非阻塞文件锁、有限大小和超时；只请求固定公开页面，不跟随跳转，不请求原帖或图片。
- 来源结构变化、空列表、网络故障时保留历史与最后成功时间；页面显示同步失败或超过 36 小时未更新提示。
- 文本由模板转义，外链只保留已审核的 HTTPS 域名；来源 HTML 与脚本不会执行。
- 临时文件与快照在同目录中原子替换；单次命令退出后没有轮询进程。

## 单次同步

在包含此版本的检测容器中执行：

```bash
docker exec gewu-detector python -m web.updates
```

可用 `--limit 1` 只合并当次最新一篇。它不会删除以前已收录的内容。

## 每日运行

随代码提供 `deploy/gewu-updates.service` 和 `deploy/gewu-updates.timer`。时间为 **每天北京时间 09:00**，最多随机延迟 60 秒；错过触发时在定时器恢复后补跑一次。不能补回来源首页已移出的历史条目。

先按现有固定版本镜像发布流程更新检测容器，验证单次命令成功，再安装这两个 unit：

```bash
sudo install -m 0644 detector/deploy/gewu-updates.service /etc/systemd/system/gewu-updates.service
sudo install -m 0644 detector/deploy/gewu-updates.timer /etc/systemd/system/gewu-updates.timer
sudo systemctl daemon-reload
sudo systemctl enable --now gewu-updates.timer
sudo systemctl start gewu-updates.service
sudo systemctl status gewu-updates.timer --no-pager
sudo journalctl -u gewu-updates.service -n 20 --no-pager
```

定时器安装不随网页访问自动发生，也不代表已经在生产启用。回退不支持动态的旧容器版本前，先停止该定时器；快照可保留。

```bash
sudo systemctl disable --now gewu-updates.timer
```

## 验证

`tests/test_updates.py` 覆盖来源分块解析、时间与结构校验、去重与修订、故障保留、恶意外链、HTML 转义、只读页面、重定向与大小限制。生产验收另需确认页面、数据卷写入、定时器下次执行时间及失败记录。

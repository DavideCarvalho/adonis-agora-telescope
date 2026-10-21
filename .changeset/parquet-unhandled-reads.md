---
'@adonis-agora/telescope': patch
---

The Parquet cold tier no longer leaves unhandled promise rejections behind when a file is deleted while it is being read (retention or compaction racing a dashboard read). hyparquet prefetches several byte ranges per file on filtered reads and awaits only the first that fails; the rest used to reject unhandled, which crashes a Node process running with the default `--unhandled-rejections=throw`.

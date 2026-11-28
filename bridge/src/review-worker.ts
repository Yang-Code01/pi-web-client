/**
 * 一次代码评审的执行进程（D441）。
 *
 * 它由脑 detached 起出来，自己读 job、跑 `execute()`、把进度写回 `<state>/review/jobs/`。
 * 脑换掉 / 崩掉 / 更新重启都不影响它：新脑开机扫 job 文件，把 pid 还活着的那几条接回来。
 *
 * 用法：node review-worker.js <job-file>
 */
import { runReviewJob } from "./review.ts";

const jobFile = process.argv[2];
if (!jobFile) {
  console.error("usage: review-worker <job-file>");
  process.exit(2);
}

runReviewJob(jobFile).then(
  () => process.exit(0),
  (err) => {
    // 进度文件留在盘上，脑的 ticker 会按「执行进程没了」把这条收尾；
    // 这里只把原因写进 job 日志，方便下次有人问「为什么没跑完」。
    console.error("[review-worker]", err?.stack ?? err);
    process.exit(1);
  },
);

/** CLIで表示する簡潔な使用方法を返す。 */
export function formatCliUsage(): string {
  return [
    "使用方法:",
    "  voicevox-task-tracker daily [--config PATH] [--notification-action send|hold|acknowledge-current] [--sandbox-context PATH] [--scheduled-for ISO] [--report PATH]",
    "  voicevox-task-tracker dry-run [--config PATH] [--artifact PATH] [--report PATH]",
    "  voicevox-task-tracker backfill [--mode none|linked|all-open] [--notification-action send|hold|acknowledge-current] [--repository VOICEVOX/REPO]",
    "  voicevox-task-tracker collect-analyze [--mode none|linked|all-open] [--notification-action send|hold|acknowledge-current] [--scheduled-for ISO] [--artifact PATH]",
    "  voicevox-task-tracker persist-state [--config PATH] [--artifact PATH] [--receipt PATH]",
    "  voicevox-task-tracker build-pages [--config PATH] [--receipt PATH] [--build-artifact PATH] [--output PATH]",
    "  voicevox-task-tracker prepare-notification-history-pages [--config PATH] [--settlement-receipt PATH] [--finalization-receipt PATH] [--build-artifact PATH] [--output PATH]",
    "  voicevox-task-tracker preflight-notification-history-deployment [--config PATH] [--settlement-receipt PATH] [--finalization-receipt PATH] [--build-artifact PATH] [--previous-outcome PATH] [--preflight PATH] [--run-attempt NUMBER]",
    "  voicevox-task-tracker record-notification-history-deployment [--build-artifact PATH] [--preflight PATH] [--outcome PATH]",
    "  voicevox-task-tracker preflight-pages-deployment [--config PATH] [--receipt PATH] [--build-artifact PATH] [--preflight PATH] [--run-attempt NUMBER]",
    "  voicevox-task-tracker record-pages-deployment [--build-artifact PATH] [--preflight PATH] [--outcome PATH]",
    "  voicevox-task-tracker settle-notifications [--receipt PATH] [--build-artifact PATH] [--pages-deployment PATH] [--manual-resolution-receipt PATH] [--settlement-receipt PATH]",
    "  voicevox-task-tracker finalize-run [--receipt PATH] [--settlement-receipt PATH] [--finalization-receipt PATH]",
    "  voicevox-task-tracker resolve-discord-delivery --run-id ID --checkpoint-digest DIGEST --delivery-id ID --attempt-id ID --notification-key KEY --resolution retry|acknowledge [--receipt PATH]",
    "  voicevox-task-tracker notify-operations --workflow-run-id ID --workflow-run-attempt NUMBER --workflow-kind daily|manual --occurred-at ISO --failed-job JOB [--failure-directory PATH] [--previous-failures-directory PATH] [--previous-receipts-directory PATH]",
    "  voicevox-task-tracker report-workflow --run-id ID --run-attempt NUMBER --quality-result RESULT --collect-analyze-result RESULT --persist-state-result RESULT --build-pages-result RESULT --deploy-pages-result RESULT --notify-discord-result RESULT --publish-notification-history-result RESULT --notify-operations-result RESULT",
    "  voicevox-task-tracker verify-state --state-directory PATH [--config PATH]",
    "  voicevox-task-tracker verify-checkpoint [--artifact PATH] [--config PATH]",
    "  voicevox-task-tracker verify-runtime-recovery --input PATH [--bundle-root PATH]",
    "  voicevox-task-tracker inspect-run-state [--config PATH] [--state-ref REF] [--run-id ID --state-revision SHA]",
    "  voicevox-task-tracker verify-receipt-chain --input PATH",
    "  voicevox-task-tracker report-failure --input PATH --output PATH",
  ].join("\n");
}

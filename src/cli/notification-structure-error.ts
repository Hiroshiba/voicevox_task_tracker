/** 通知stateの構造違反と失敗した操作の副作用確度。 */
export class NotificationStructureError extends TypeError {
  public readonly effectCertainty: "no_effect" | "committed";

  public constructor(
    message: string,
    effectCertainty: "no_effect" | "committed",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "NotificationStructureError";
    this.effectCertainty = effectCertainty;
  }
}

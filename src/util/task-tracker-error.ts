/** VOICEVOX Task Trackerで発生するエラーの基底クラス。 */
export abstract class TaskTrackerError extends Error {
  protected constructor(message: string, options: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

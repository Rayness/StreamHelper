/** Global and per-user cooldowns for commands. Clock is injectable for tests. */
export class Cooldowns {
  private global = new Map<string, number>();
  private perUser = new Map<string, number>();

  constructor(private now: () => number = Date.now) {}

  /** True if the command may run now. Does not start the cooldown. */
  ready(commandId: string, userId: string, globalSec: number, userSec: number): boolean {
    const t = this.now();
    if (globalSec > 0 && (this.global.get(commandId) ?? 0) > t) return false;
    if (userSec > 0 && (this.perUser.get(`${commandId}:${userId}`) ?? 0) > t) return false;
    return true;
  }

  start(commandId: string, userId: string, globalSec: number, userSec: number): void {
    const t = this.now();
    if (globalSec > 0) this.global.set(commandId, t + globalSec * 1000);
    if (userSec > 0) this.perUser.set(`${commandId}:${userId}`, t + userSec * 1000);
  }

  clear(): void {
    this.global.clear();
    this.perUser.clear();
  }
}

/** A pending refresh or appearance request belongs to one saved sign-in. */
export type AccountLease = {
  readonly id: string;
  isCurrent(): boolean;
  assertCurrent(): void;
};

export class AccountLifecycle {
  private readonly generations = new Map<string, object>();

  replace(id: string): void {
    this.generations.set(id, {});
  }

  remove(id: string): void {
    this.generations.delete(id);
  }

  capture(id: string): AccountLease {
    const generation = this.generations.get(id);
    const isCurrent = () =>
      generation !== undefined && this.generations.get(id) === generation;
    const assertCurrent = () => {
      if (!isCurrent())
        throw new Error("账号已移除或重新登录，请重新选择账号后重试。");
    };
    assertCurrent();
    return { id, isCurrent, assertCurrent };
  }
}

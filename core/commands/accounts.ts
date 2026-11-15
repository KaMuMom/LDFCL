import type { LauncherRuntime } from "../runtime";
import type { CommandHandlers } from "./registry";
export function accountsCommands(ctx: LauncherRuntime): CommandHandlers {
  return {
    "account:offline": async (p: any = {}) => {
      {
        const a = await ctx.accounts.addOffline(p.name);
        ctx.store.selectedAccountId = a.id;
        await ctx.store.save();
        return a;
      }
    },
    "account:microsoft": async (p: any = {}) => {
      {
        const dispatchRun = ++ctx.microsoftDispatchRun;
        ctx.microsoftClipboardStatus = undefined;
        ctx.accounts.cancelMicrosoft();
        const flow = await ctx.accounts.beginMicrosoftDevice(
          ctx.store.getMicrosoftClientId(),
        );
        const isCurrent = () =>
          dispatchRun === ctx.microsoftDispatchRun &&
          ctx.accounts.isMicrosoftDeviceChallengeActive(flow);
        if (!isCurrent()) throw Error("此 Microsoft 登录请求已取消。");
        let codeCopied = false;
        try {
          if (ctx.host.writeClipboardText) {
            ctx.host.writeClipboardText(flow.userCode);
            codeCopied = true;
          }
        } catch {
          // Clipboard availability must not prevent Microsoft authorization.
        }
        const copyMessage = codeCopied
          ? undefined
          : "未能自动复制授权码，请使用“复制授权码”按钮或手动输入。";
        if (!isCurrent()) throw Error("此 Microsoft 登录请求已取消。");
        ctx.microsoftClipboardStatus = {
          run: dispatchRun,
          userCode: flow.userCode,
          codeCopied,
          copyMessage,
        };
        ctx.emit({
          type: "auth-status",
          status: "waiting",
          ...flow,
          codeCopied,
          copyMessage,
          message: codeCopied
            ? "授权码已自动复制，请在 Microsoft 授权页面粘贴并完成登录。"
            : "请在 Microsoft 授权页面输入设备代码，完成授权后将自动继续。",
        });
        if (!isCurrent()) throw Error("此 Microsoft 登录请求已取消。");
        try {
          await ctx.host.openExternal(flow.verificationUri);
        } catch {
          if (dispatchRun === ctx.microsoftDispatchRun)
            ctx.accounts.cancelMicrosoft();
          throw Error("无法打开系统浏览器，请检查默认浏览器后重试");
        }
        return { ...flow, codeCopied, ...(copyMessage ? { copyMessage } : {}) };
      }
    },
    "account:cancel": async (p: any = {}) => {
      ctx.microsoftDispatchRun++;
      ctx.microsoftClipboardStatus = undefined;
      return ctx.accounts.cancelMicrosoft();
    },
    "account:yggdrasil": async (p: any = {}) => {
      {
        const a = await ctx.accounts.addYggdrasil(p);
        ctx.store.selectedAccountId = a.id;
        await ctx.store.save();
        return a;
      }
    },
    "account:remove": async (p: any = {}) => {
      await ctx.accounts.remove(p.id);
      return ctx.state();
    },
  };
}

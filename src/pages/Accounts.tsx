import {
  ArrowUpRight,
  Check,
  Globe,
  Plus,
  ShieldCheck,
  Shirt,
  Trash2,
  UserRound,
} from "lucide-react";
import { useState } from "react";
import type { Account } from "@ldfcl/contracts/types";
import type useLauncher from "../hooks/useLauncher";
import { GlassSurface } from "../ui/Glass";
import Modal from "../ui/Modal";
import PageTitle from "../ui/PageTitle";
const kinds = {
  microsoft: "Microsoft 正版",
  offline: "离线账号",
  yggdrasil: "第三方皮肤站",
};
export default function Accounts({
  controller: c,
}: {
  controller: ReturnType<typeof useLauncher>;
}) {
  const [removing, setRemoving] = useState<Account>();
  return (
    <>
      <PageTitle
        eyebrow="YOUR IDENTITIES"
        title="账号管理"
        subtitle="你的每一个身份，都在这里。切换后将在下次启动游戏时生效。"
      >
        <button className="btn primary" onClick={() => c.setModal("account")}>
          <Plus size={17} />
          添加账号
        </button>
      </PageTitle>
      <div className="account-summary">
        <ShieldCheck size={20} />
        <div>
          <strong>登录信息保存在本机</strong>
          <p>微软登录通过浏览器设备代码授权；也支持离线身份和其他皮肤站。</p>
        </div>
      </div>
      {c.state.accounts.length ? (
        <div className="account-grid">
          {c.state.accounts.map((a) => {
            const selected = a.id === c.account?.id;
            const Icon =
              a.type === "microsoft"
                ? ShieldCheck
                : a.type === "yggdrasil"
                  ? Globe
                  : UserRound;
            return (
              <GlassSurface
                className={`identity-card ${selected ? "selected" : ""}`}
                key={a.id}
              >
                <div className="identity-heading">
                  <span className="identity-icon">
                    <Icon size={26} />
                  </span>
                  {selected && (
                    <span className="badge success">
                      <Check size={12} />
                      当前身份
                    </span>
                  )}
                </div>
                <h2>{a.name}</h2>
                <span className="muted">{kinds[a.type]}</span>
                {a.server && (
                  <p className="identity-server" title={a.server}>
                    {a.server}
                  </p>
                )}
                <div className="identity-actions">
                  <button
                    className={`btn ${selected ? "subtle" : "primary"}`}
                    disabled={selected || !!c.busy}
                    onClick={() =>
                      void c.action("select-account", () =>
                        c.selectAccount(a.id),
                      )
                    }
                  >
                    {selected ? "正在使用" : "使用此账号"}
                    <ArrowUpRight size={14} />
                  </button>
                  <button
                    className="icon-button danger"
                    aria-label={`移除 ${a.name}`}
                    onClick={() => setRemoving(a)}
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              </GlassSurface>
            );
          })}
        </div>
      ) : (
        <GlassSurface className="empty">
          <div className="empty-icon">
            <UserRound size={30} />
          </div>
          <h3>添加你的第一个身份</h3>
          <p>登录正版账号，或创建一个离线角色。</p>
          <button className="btn primary" onClick={() => c.setModal("account")}>
            <Plus size={16} />
            添加账号
          </button>
        </GlassSurface>
      )}
      <button
        className="account-wardrobe-link"
        onClick={() => c.setPage("wardrobe")}
      >
        <Shirt size={22} />
        <span>
          <strong>让角色更像你</strong>
          <small>前往皮肤与披风，预览、编辑和收藏皮肤</small>
        </span>
        <ArrowUpRight size={18} />
      </button>
      {removing && (
        <Modal
          title={`移除 ${removing.name}？`}
          subtitle="仅移除此启动器中保存的登录身份。你可以随时重新添加。"
          close={() => {
            if (!c.busy) setRemoving(undefined);
          }}
        >
          <div className="dialog-actions">
            <button
              className="btn"
              disabled={!!c.busy}
              onClick={() => setRemoving(undefined)}
            >
              取消
            </button>
            <button
              className="btn danger"
              disabled={!!c.busy}
              onClick={() =>
                void c.action("remove-account", async () => {
                  await c.call("account:remove", { id: removing.id });
                  await c.refresh();
                  setRemoving(undefined);
                  c.notify("账号已移除");
                })
              }
            >
              确认移除
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}

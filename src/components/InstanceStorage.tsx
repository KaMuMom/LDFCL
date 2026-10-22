import { useEffect, useState } from "react";
import { Archive, Download, RotateCcw, Plus, RefreshCw } from "lucide-react";
import type { LauncherAPI } from "../../shared/types";
import "./improvements.css";

export default function InstanceStorage({
  instanceId,
  call,
  refresh,
  notify,
}: {
  instanceId: string;
  call: LauncherAPI["call"];
  refresh: () => Promise<void>;
  notify: (message: string) => void;
}) {
  const [snapshots, setSnapshots] = useState<any[]>([]);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<any>(null);
  const [manifest, setManifest] = useState<any>(null);
  const load = () =>
    call<any[]>("snapshot:list", { id: instanceId }).then(setSnapshots);
  useEffect(() => {
    let active = true;
    void call<any[]>("snapshot:list", { id: instanceId })
      .then((value) => {
        if (active) setSnapshots(value);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [instanceId]);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (error: any) {
      notify(String(error.message || error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="storage-panel">
      <div className="improvement-heading">
        <h3>
          <Archive size={17} /> 实例清单与快照
        </h3>
        <button
          className="btn subtle"
          disabled={busy}
          onClick={() => void run(load)}
        >
          <RefreshCw size={15} />
          刷新
        </button>
      </div>
      <p className="muted">
        修改 Mod 和设置前自动保存快照。回滚包含 Mod、配置、资源包、光影和
        options，存档、截图及日志继续保留。
      </p>
      <div className="button-group">
        <button
          className="btn subtle"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const result = await call("instance:manifest", {
                id: instanceId,
                save: true,
              });
              if (result) notify("实例 manifest 已导出");
            })
          }
        >
          <Download size={15} />
          导出 manifest
        </button>
        <button
          className="btn subtle"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const result = await call("instance:manifest", {
                id: instanceId,
                exportBundle: true,
              });
              if (result) notify("包含实例文件的可迁移清单包已导出");
            })
          }
        >
          <Archive size={15} />
          导出清单包
        </button>
        <button
          className="btn subtle"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              setManifest(await call("instance:manifest", { id: instanceId }));
            })
          }
        >
          查看当前清单
        </button>
      </div>
      {manifest && (
        <details open>
          <summary>instance.manifest.json</summary>
          <pre>{JSON.stringify(manifest, null, 2)}</pre>
        </details>
      )}
      <div className="input-with-button">
        <input
          aria-label="快照名称"
          placeholder="快照名称（可选）"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <button
          className="btn primary"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await call("snapshot:create", { id: instanceId, name });
              setName("");
              await load();
              notify("快照已创建");
            })
          }
        >
          <Plus size={15} />
          创建快照
        </button>
      </div>
      <div className="snapshot-list">
        {snapshots.map((snapshot) => (
          <div className="snapshot-row" key={snapshot.id}>
            <div>
              <strong>{snapshot.name || snapshot.id}</strong>
              <p className="muted">
                {new Date(snapshot.createdAt).toLocaleString("zh-CN")}
              </p>
            </div>
            <button
              className="btn subtle"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const result = await call("snapshot:preview", {
                    id: instanceId,
                    snapshotId: snapshot.id,
                  });
                  setPreview({ ...result, snapshotId: snapshot.id });
                })
              }
            >
              <RotateCcw size={15} />
              查看回滚变更
            </button>
          </div>
        ))}
        {!snapshots.length && <p className="muted">还没有快照。</p>}
      </div>
      {preview && (
        <div className="health-panel" role="region" aria-label="回滚预览">
          <h3>回滚前确认文件变更</h3>
          <pre>{JSON.stringify(preview, null, 2)}</pre>
          <p>执行前会额外创建保护快照。继续会替换上方列出的受管文件。</p>
          <div className="button-group">
            <button className="btn subtle" onClick={() => setPreview(null)}>
              取消
            </button>
            <button
              className="btn danger"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await call("snapshot:restore", {
                    id: instanceId,
                    snapshotId: preview.snapshotId,
                    expectedPreviewId: preview.previewId,
                    apply: true,
                  });
                  setPreview(null);
                  await refresh();
                  await load();
                  notify("已回滚，回滚前状态保留为保护快照");
                })
              }
            >
              确认回滚
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

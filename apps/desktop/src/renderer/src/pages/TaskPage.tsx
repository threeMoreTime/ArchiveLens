import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Button, Text } from "@fluentui/react-components";

export default function TaskPage() {
  const { taskId = "" } = useParams();
  const nav = useNavigate();
  const [task, setTask] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const t = await window.archiveLens.tasks.get(taskId);
        if (active) setTask(t);
      } catch (e: unknown) {
        if (active) setError(e instanceof Error ? e.message : String(e));
      }
    };
    load();
    const off = window.archiveLens.subscribe.onEvent((e: any) => {
      if (e?.task_id === taskId) load();
    });
    const timer = setInterval(load, 2500);
    return () => {
      active = false;
      off();
      clearInterval(timer);
    };
  }, [taskId]);

  return (
    <div className="al-welcome">
      <h1>扫描任务</h1>
      {error && <div className="al-error">{error}</div>}
      {task && (
        <div className="al-task-meta">
          <Text>来源：{task.source_dir}</Text>
          <br />
          <Text>检索词：{task.search_text}</Text>
          <br />
          <Text>匹配模式：{task.search_mode === "legacy_fixed_pair" ? "历史双字符匹配" : "精确匹配"}</Text>
          <br />
          <Text>状态：<b>{task.status}</b></Text>
          <br />
          <Text>
            文件 {task.file_count} · 命中 {task.occurrence_count} · 已处理页 {task.processed_pages}/
            {task.total_pages}
          </Text>
          {task.error_message && (
            <>
              <br />
              <Text className="al-error">{task.error_message}</Text>
            </>
          )}
        </div>
      )}
      <div className="al-welcome-actions">
        <Button appearance="primary" onClick={() => nav(`/review/${taskId}`)}>
          进入校对工作台
        </Button>
        {task && (task.status === "running") && (
          <Button onClick={() => window.archiveLens.tasks.pause(taskId)}>暂停</Button>
        )}
        {task && (task.status === "paused" || task.status === "recoverable") && (
          <Button onClick={() => window.archiveLens.tasks.resume(taskId)}>继续</Button>
        )}
        {task && task.status !== "cancelled" && task.status !== "completed" && (
          <Button onClick={() => window.archiveLens.tasks.cancel(taskId)}>取消</Button>
        )}
      </div>
    </div>
  );
}

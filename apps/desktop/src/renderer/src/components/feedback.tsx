import { Button, Spinner, Text } from "@fluentui/react-components";

export function PageHeader({ title, description }: { title: string; description?: string }) {
  return <header className="al-page-header"><h1>{title}</h1>{description && <Text className="al-subtitle">{description}</Text>}</header>;
}

export function InlineFeedback({ tone = "error", children }: { tone?: "error" | "warning" | "info"; children: React.ReactNode }) {
  return <div className={`al-feedback al-feedback-${tone}`} role={tone === "error" ? "alert" : "status"}>{children}</div>;
}

export function LoadingState({ label = "正在加载…" }: { label?: string }) {
  return <div className="al-loading" role="status" aria-live="polite"><Spinner size="tiny" /><span>{label}</span></div>;
}

export function EmptyState({ title, detail, action }: { title: string; detail?: string; action?: { label: string; onClick: () => void } }) {
  return <div className="al-empty"><Text weight="semibold">{title}</Text>{detail && <Text className="al-muted">{detail}</Text>}{action && <Button onClick={action.onClick}>{action.label}</Button>}</div>;
}

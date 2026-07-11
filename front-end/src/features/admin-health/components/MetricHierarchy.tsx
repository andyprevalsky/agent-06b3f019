export function MetricSectionHeader({
  index,
  title,
  description,
}: {
  index: string;
  title: string;
  description: string;
}) {
  return (
    <div className="border-b border-border/70 pb-4 pt-4">
      <p className="text-xs font-medium uppercase text-muted-foreground">Section {index}</p>
      <h2 className="mt-1 text-2xl font-semibold">{title}</h2>
      <p className="mt-1 max-w-3xl text-sm leading-6 text-muted-foreground">{description}</p>
    </div>
  );
}
/**
 * STATE MACHINE: MetricSectionHeader
 * [VISIBLE] -> fixed section index, title, and description
 */

import type { ReactNode } from "react";

/** Page title with a one-line description and the page's main actions on the right. */
export default function PageHead({ title, lead, actions, children }: {
  title: string; lead?: ReactNode; actions?: ReactNode; children?: ReactNode;
}) {
  return (
    <header className="page-head">
      <div className="page-head-text">
        <h1>{title}</h1>
        {lead && <p className="lead">{lead}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
      {children}
    </header>
  );
}

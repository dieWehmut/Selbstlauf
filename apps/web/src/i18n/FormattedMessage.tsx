import { Fragment, type ReactNode } from 'react';
import { useI18n } from './index';

/** Translate a whole sentence while retaining explicitly supplied React nodes. */
export function FormattedMessage(props: {
  readonly source: string;
  readonly params: Readonly<Record<string, ReactNode>>;
}) {
  const { t } = useI18n();
  const parts = t(props.source).split(/(\{[A-Za-z][A-Za-z0-9_]*\})/gu);
  return <>{parts.map((part, index) => {
    const key = /^\{([A-Za-z][A-Za-z0-9_]*)\}$/u.exec(part)?.[1];
    return <Fragment key={index}>{key !== undefined && Object.hasOwn(props.params, key) ? props.params[key] : part}</Fragment>;
  })}</>;
}

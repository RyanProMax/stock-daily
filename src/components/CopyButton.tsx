import { useState } from "react";
import { Button } from "react-aria-components";
import { Check, Copy } from "lucide-react";

interface Props {
  text: string;
  label: string;
  copiedLabel: string;
}

export default function CopyButton({ text, label, copiedLabel }: Props) {
  const [copied, setCopied] = useState(false);

  async function copyText() {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  return (
    <Button className="copy-button" onPress={copyText}>
      {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      {copied ? copiedLabel : label}
    </Button>
  );
}

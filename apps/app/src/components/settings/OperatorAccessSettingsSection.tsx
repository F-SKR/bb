import { useState } from "react";
import { Button } from "@bb/shared-ui/button";
import { Input } from "@bb/shared-ui/input";
import { cn } from "@bb/shared-ui/lib/utils";
import {
  SettingsSection,
  SettingsWithControl,
} from "@/components/ui/settings-section.js";
import {
  clearStoredOperatorToken,
  getStoredOperatorToken,
  setStoredOperatorToken,
} from "@/lib/operator-token";

export function OperatorAccessSettingsSection() {
  const [storedToken, setStoredToken] = useState(getStoredOperatorToken);
  const [draft, setDraft] = useState(storedToken);

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed.length === 0) {
      clearStoredOperatorToken();
      setStoredToken("");
      setDraft("");
      return;
    }
    setStoredOperatorToken(trimmed);
    setStoredToken(trimmed);
    setDraft(trimmed);
  };

  return (
    <SettingsSection
      title="Operator access"
      description="Server changes that are reserved for the operator — such as Tasks preset create, update, and delete — accept requests only when they carry the server's operator token."
    >
      <div className="space-y-5">
        <SettingsWithControl
          label="Operator token"
          description="Copy the contents of the bb data dir's operator-token file. The bb CLI reads the same secret from BB_OPERATOR_TOKEN."
          controlPlacement="below"
        >
          <div className="flex items-center gap-2">
            <Input
              value={draft}
              aria-label="Operator token"
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="Not configured — preset changes are refused"
              className={cn("h-8 font-mono text-xs")}
              onChange={(event) => setDraft(event.target.value)}
              onBlur={commit}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  commit();
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  setDraft(storedToken);
                }
              }}
            />
            {storedToken.length > 0 ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 shrink-0 px-2.5 text-xs"
                aria-label="Forget operator token"
                onClick={() => {
                  clearStoredOperatorToken();
                  setStoredToken("");
                  setDraft("");
                }}
              >
                Forget
              </Button>
            ) : null}
          </div>
        </SettingsWithControl>
      </div>
    </SettingsSection>
  );
}

import { rawStringLocalStorage } from "@/lib/browser-storage";

export const OPERATOR_TOKEN_STORAGE_KEY = "bb.operatorToken";
export const OPERATOR_TOKEN_HEADER = "x-bb-operator-token";

export function getStoredOperatorToken(): string {
  return rawStringLocalStorage
    .getItem(OPERATOR_TOKEN_STORAGE_KEY, "")
    .trim();
}

export function setStoredOperatorToken(value: string): void {
  rawStringLocalStorage.setItem(OPERATOR_TOKEN_STORAGE_KEY, value.trim());
}

export function clearStoredOperatorToken(): void {
  rawStringLocalStorage.removeItem(OPERATOR_TOKEN_STORAGE_KEY);
}

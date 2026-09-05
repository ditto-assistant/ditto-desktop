/**
 * Ditto Account settings — sign in with Ditto and choose which Ditto backend
 * the desktop talks to.
 *
 * A Ditto account is optional: the desktop works locally without one. Signing
 * in unlocks the features that live in Ditto's cloud, starting with Google
 * Messages pairing through the hosted bridge. Linking the computer (device
 * code) gives the desktop server its own Ditto key for Teleport and Ditto Code.
 *
 * @module DittoAccountSettings
 */
import { CloudIcon, LogOutIcon, MessageSquareIcon } from "lucide-react";
import { useCallback, useState, type FormEvent } from "react";

import { DITTO_API_BASE_OPTIONS, getDittoApiBaseUrl, setDittoApiBaseUrl } from "~/ditto/apiBase";
import { isDittoCloudConfigured } from "~/ditto/config";
import {
  describeDittoSignInError,
  signInWithDittoEmail,
  signInWithDittoGoogle,
  signOutOfDitto,
} from "~/ditto/firebase";
import { useDittoUser } from "~/ditto/useDittoUser";

import { Button } from "../ui/button";
import { DeviceLinkRow } from "./DittoDeviceLink";
import { GoogleMessagesConnectionRow } from "./GoogleMessagesConnection";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

function UnconfiguredNotice() {
  return (
    <SettingsRow
      {...searchableSetting("ditto-account")}
      description="This build has no Ditto cloud configuration. Add the DITTO_FIREBASE_* values from .env.example to the repo's .env and rebuild to enable sign-in."
    />
  );
}

function SignInForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState<"email" | "google" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submitEmail = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (pending !== null) return;
      setPending("email");
      setError(null);
      try {
        await signInWithDittoEmail(email, password);
        setPassword("");
      } catch (cause) {
        setError(describeDittoSignInError(cause));
      } finally {
        setPending(null);
      }
    },
    [email, password, pending],
  );

  const submitGoogle = useCallback(async () => {
    if (pending !== null) return;
    setPending("google");
    setError(null);
    try {
      await signInWithDittoGoogle();
    } catch (cause) {
      setError(describeDittoSignInError(cause));
    } finally {
      setPending(null);
    }
  }, [pending]);

  const canSubmitEmail = email.trim().length > 0 && password.length > 0 && pending === null;

  return (
    <form className="flex w-full flex-col gap-3" onSubmit={(event) => void submitEmail(event)}>
      <label className="block">
        <span className="mb-1.5 block text-xs font-medium text-foreground">Email</span>
        <Input
          type="email"
          autoComplete="username"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="you@example.com"
          disabled={pending !== null}
          spellCheck={false}
        />
      </label>
      <label className="block">
        <span className="mb-1.5 block text-xs font-medium text-foreground">Password</span>
        <Input
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          disabled={pending !== null}
        />
      </label>
      {error ? (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" disabled={!canSubmitEmail}>
          {pending === "email" ? <Spinner /> : null}
          Sign in
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={pending !== null}
          onClick={() => void submitGoogle()}
        >
          {pending === "google" ? <Spinner /> : null}
          Sign in with Google
        </Button>
      </div>
    </form>
  );
}

function AccountRow() {
  const { ready, user } = useDittoUser();
  const [signingOut, setSigningOut] = useState(false);

  const signOut = useCallback(async () => {
    setSigningOut(true);
    try {
      await signOutOfDitto();
    } finally {
      setSigningOut(false);
    }
  }, []);

  if (!ready) {
    return (
      <SettingsRow
        {...searchableSetting("ditto-account")}
        description="Checking your Ditto session…"
        control={<Spinner />}
      />
    );
  }

  if (user === null) {
    return (
      <SettingsRow
        {...searchableSetting("ditto-account")}
        description="Sign in with your Ditto account to use the features that live in Ditto's cloud, such as Google Messages. Local channels and agent tasks never need an account."
      >
        <SignInForm />
      </SettingsRow>
    );
  }

  return (
    <SettingsRow
      {...searchableSetting("ditto-account")}
      description={
        <>
          Signed in as <span className="font-medium text-foreground">{user.email ?? user.uid}</span>
          .
        </>
      }
      control={
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={signingOut}
          onClick={() => void signOut()}
        >
          <LogOutIcon className="size-3.5" />
          Sign out
        </Button>
      }
    />
  );
}

function BackendRow() {
  const [baseUrl, setBaseUrl] = useState(() => getDittoApiBaseUrl());
  const selected = DITTO_API_BASE_OPTIONS.find((option) => option.url === baseUrl);

  return (
    <SettingsRow
      {...searchableSetting("ditto-backend")}
      description="Which Ditto backend this computer talks to. Production unless you are testing a backend branch on a staging slot."
      control={
        <Select
          value={baseUrl}
          onValueChange={(value) => {
            if (typeof value !== "string") return;
            const option = DITTO_API_BASE_OPTIONS.find((candidate) => candidate.url === value);
            if (option === undefined) return;
            setDittoApiBaseUrl(option.id === "production" ? null : option.url);
            setBaseUrl(option.url);
          }}
        >
          <SelectTrigger className="w-full sm:w-44" aria-label="Ditto backend">
            <SelectValue>{selected?.label ?? baseUrl}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {DITTO_API_BASE_OPTIONS.map((option) => (
              <SelectItem hideIndicator key={option.id} value={option.url}>
                {option.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}

function ConnectionsSection() {
  const { ready, user } = useDittoUser();
  if (!ready || user === null) return null;
  return (
    <SettingsSection title="Connections" icon={<MessageSquareIcon className="size-4" />}>
      <GoogleMessagesConnectionRow user={user} />
    </SettingsSection>
  );
}

export function DittoAccountSettingsPanel() {
  const configured = isDittoCloudConfigured();
  return (
    <SettingsPageContainer>
      <SettingsSection title="Ditto Account" icon={<CloudIcon className="size-4" />}>
        {configured ? (
          <>
            <AccountRow />
            <BackendRow />
            <DeviceLinkRow />
          </>
        ) : (
          <UnconfiguredNotice />
        )}
      </SettingsSection>
      {configured ? <ConnectionsSection /> : null}
    </SettingsPageContainer>
  );
}

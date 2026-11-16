// The server's address, then signing in to it, then the relay. With an
// address saved, it goes straight through unless the server needs a password.
import * as SecureStore from "expo-secure-store";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { startRelay } from "../relay";
import type { Relay } from "../relay/types";
import { createSession } from "../server";
import type { Session } from "../server/types";
import { colors } from "./kit";

export const SERVER_KEY = "server";

/** https://host, from what the person typed; null unless it's https. */
function originOf(input: string): string | null {
	input = input.trim();
	try {
		const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `https://${input}`);
		return url.protocol === "https:" && url.hostname.includes(".") ? url.origin : null;
	} catch {
		return null;
	}
}

export function FirstRun({ onReady }: { onReady: (ready: { session: Session; relay: Relay }) => void }) {
	const [step, setStep] = useState<"start" | "address" | "password">("start");
	const [address, setAddress] = useState("");
	const [password, setPassword] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const session = useRef<Session | null>(null);

	const connect = async (input: string, typed?: string) => {
		const origin = originOf(input);
		if (!origin) {
			setStep("address");
			return setError("Enter the server's address, like badger.example.com. It needs https.");
		}
		setBusy(true);
		setError("");
		try {
			if (session.current?.origin !== origin) session.current = createSession(origin);
			const s = session.current;
			if (!(await s.signedIn())) {
				const mode = await s.accessMode();
				if (mode === "password" && typed === undefined) return setStep("password");
				if (mode !== "off") await s.signIn(typed);
			}
			await SecureStore.setItemAsync(SERVER_KEY, origin);
			onReady({ session: s, relay: await startRelay({ wispUrl: s.wispUrl, defaultRoute: "relay" }) });
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setStep((now) => (now === "start" ? "address" : now));
		} finally {
			setBusy(false);
		}
	};

	useEffect(() => {
		SecureStore.getItemAsync(SERVER_KEY).then(
			(saved) => {
				if (!saved) return setStep("address");
				setAddress(saved);
				connect(saved);
			},
			() => setStep("address")
		);
		// once, at start
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	return (
		<SafeAreaView style={styles.page}>
			<Text style={styles.name} accessibilityRole="header">
				Badger
			</Text>
			{step === "start" ? null : step === "address" ? (
				<View style={styles.form}>
					<Text style={styles.note}>Badger browses through your Badger server, so sites see its address, not yours. Which server?</Text>
					<TextInput
						style={styles.input}
						value={address}
						onChangeText={setAddress}
						placeholder="badger.example.com"
						accessibilityLabel="Server address"
						autoCapitalize="none"
						autoCorrect={false}
						keyboardType="url"
						returnKeyType="go"
						autoFocus
						editable={!busy}
						onSubmitEditing={() => connect(address)}
					/>
					<Pressable accessibilityRole="button" style={styles.button} disabled={busy} onPress={() => connect(address)}>
						<Text style={styles.buttonText}>Connect</Text>
					</Pressable>
				</View>
			) : (
				<View style={styles.form}>
					<Text style={styles.note}>{address}</Text>
					<TextInput
						style={styles.input}
						value={password}
						onChangeText={setPassword}
						placeholder="Password"
						accessibilityLabel="Password"
						secureTextEntry
						textContentType="password"
						returnKeyType="go"
						autoFocus
						editable={!busy}
						onSubmitEditing={() => connect(address, password)}
					/>
					<Pressable accessibilityRole="button" style={styles.button} disabled={busy} onPress={() => connect(address, password)}>
						<Text style={styles.buttonText}>Sign in</Text>
					</Pressable>
					<Pressable accessibilityRole="button" onPress={() => (setStep("address"), setError(""))}>
						<Text style={styles.link}>Another server</Text>
					</Pressable>
				</View>
			)}
			{busy || step === "start" ? <ActivityIndicator style={styles.spinner} accessibilityLabel="Connecting" /> : null}
			{error ? (
				<Text style={styles.error} accessibilityRole="alert">
					{error}
				</Text>
			) : null}
		</SafeAreaView>
	);
}

const styles = StyleSheet.create({
	page: { flex: 1, backgroundColor: colors.bg, padding: 24, justifyContent: "center" },
	name: { fontSize: 34, fontWeight: "700", color: colors.ink, textAlign: "center", marginBottom: 24 },
	form: { gap: 12 },
	note: { fontSize: 15, color: colors.muted, textAlign: "center" },
	input: { fontSize: 17, padding: 14, borderRadius: 12, backgroundColor: colors.field, color: colors.text },
	button: { padding: 14, borderRadius: 12, backgroundColor: colors.ink, alignItems: "center" },
	buttonText: { fontSize: 17, fontWeight: "600", color: "#fff" },
	link: { fontSize: 15, color: colors.muted, textAlign: "center", padding: 8 },
	spinner: { marginTop: 24 },
	error: { marginTop: 16, fontSize: 15, color: colors.danger, textAlign: "center" },
});

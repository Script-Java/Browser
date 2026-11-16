// The shield menu: this site's connection and protections, and its certificate.
import { CryptoDigestAlgorithm, digest } from "expo-crypto";
import { useState } from "react";
import { Switch, Text, View } from "react-native";

import type { BadgerWebViewRef, Level } from "../../modules/badger-webview";
import { type Certificate, colonHex, fromBase64, parseCertificate } from "../cert";
import type { effective, SiteSettings } from "../sites";
import { Heading, Note, Row, Sheet, styles } from "./kit";

export const LEVELS: { level: Level; name: string; note: string }[] = [
	{ level: "standard", name: "Standard", note: "Every site works as usual" },
	{
		level: "safer",
		name: "Safer",
		note: "No WebGL or WebGPU, and sites learn less about this device: they see English, and times in UTC. Some sites look or work worse.",
	},
	{ level: "safest", name: "Safest", note: "Everything in Safer, and no site's own scripts at all. Many sites stop working: menus, videos, sign-ins." },
];

type Chain = { cert: Certificate; sha256: string }[];

export function ShieldSheet({
	site,
	settings,
	view,
	onChange,
	onClose,
}: {
	site: string | null;
	settings: ReturnType<typeof effective>;
	view: () => BadgerWebViewRef | null | undefined;
	onChange: (change: SiteSettings) => void;
	onClose: () => void;
}) {
	const [chain, setChain] = useState<Chain | "none" | "error" | null>(null);

	const showCertificate = async () => {
		try {
			const der = await view()?.certificate();
			if (!der?.length) return setChain("none");
			setChain(
				await Promise.all(
					der.map(async (b64) => {
						const bytes = fromBase64(b64);
						return { cert: parseCertificate(bytes), sha256: colonHex(await digest(CryptoDigestAlgorithm.SHA256, bytes as Uint8Array<ArrayBuffer>)) };
					})
				)
			);
		} catch (err) {
			console.warn("certificate:", err);
			setChain("error");
		}
	};

	if (!site)
		return (
			<Sheet title="This page" visible onClose={onClose}>
				<Note>Open a site to choose how Badger treats it.</Note>
			</Sheet>
		);

	return (
		<Sheet title={site} visible onClose={onClose}>
			<Heading>Connection</Heading>
			<Row label="Relay" note="Through your Badger server: the site sees the server's address, not yours." checked={settings.route === "relay"} onPress={() => onChange({ route: "relay" })} />
			<Row
				label="Direct"
				note="From this phone: the site sees your address, here and wherever other sites embed its content. For robot checks, calls and sites that refuse the server."
				checked={settings.route === "direct"}
				onPress={() => onChange({ route: "direct" })}
			/>

			<Heading>Protection</Heading>
			<Row
				label="Block ads and trackers"
				note="Also answers cookie notices and blurs what scripts learn about this device"
				right={<Switch accessibilityLabel="Block ads and trackers" value={settings.blocking} onValueChange={(blocking) => onChange({ blocking })} />}
			/>
			<Row
				label="Lockdown"
				note="The engine's own hardening: no JIT, WebGL, WebRTC or some fonts and media formats. On for Relay sites and at Safest. Off on a Relay site, WebRTC and WebTransport could show the site this phone's address."
				right={<Switch accessibilityLabel="Lockdown" value={settings.lockdown} onValueChange={(lockdown) => onChange({ lockdown })} />}
			/>
			<Row
				label="Allow passkeys (WebAuthn)"
				note="Passkeys and security keys. Some of their requests go around the relay."
				right={<Switch accessibilityLabel="Allow passkeys (WebAuthn)" value={settings.passkeys} onValueChange={(passkeys) => onChange({ passkeys })} />}
			/>

			<Heading>Security level</Heading>
			{LEVELS.map(({ level, name, note }) => (
				<Row key={level} label={name} note={note} checked={settings.level === level} onPress={() => onChange({ level })} />
			))}

			<Heading>Certificate</Heading>
			{chain === null ? (
				<Row label="Show certificate" onPress={showCertificate} />
			) : chain === "none" ? (
				<Note>This page has no certificate: it isn&apos;t https.</Note>
			) : chain === "error" ? (
				<Note>Couldn&apos;t read this page&apos;s certificate.</Note>
			) : (
				chain.map(({ cert, sha256 }, i) => (
					<View key={sha256} style={styles.row} accessible>
						<View style={styles.rowText}>
							<Text style={styles.label}>{i === 0 ? "Site" : i === chain.length - 1 ? "Root or top issuer" : "Issuer"}</Text>
							<Text style={styles.note}>Subject: {cert.subject}</Text>
							<Text style={styles.note}>Issuer: {cert.issuer}</Text>
							<Text style={styles.note}>
								Valid {cert.notBefore.toLocaleDateString()} to {cert.notAfter.toLocaleDateString()}
							</Text>
							<Text style={styles.mono} selectable>
								SHA-256 {sha256}
							</Text>
						</View>
					</View>
				))
			)}
		</Sheet>
	);
}

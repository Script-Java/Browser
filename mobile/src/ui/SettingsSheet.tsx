// Settings: search engine, default level, cookie notices, the server.
import { Alert, Switch } from "react-native";

import { ENGINE_NAMES, type Engine } from "../address";
import type { Settings } from "../sites";
import { Heading, Row, Sheet } from "./kit";
import { LEVELS } from "./ShieldSheet";

type Props = {
	settings: Settings;
	server: string;
	onChange: (change: Partial<Settings>) => void;
	onSignOut: () => void;
	onClose: () => void;
};

export function SettingsSheet({ settings, server, onChange, onSignOut, onClose }: Props) {
	const signOut = () =>
		Alert.alert("Sign out?", "This device is signed out of the server, and Badger forgets it. Your tabs and workspaces stay.", [
			{ text: "Cancel", style: "cancel" },
			{ text: "Sign out", style: "destructive", onPress: onSignOut },
		]);

	return (
		<Sheet title="Settings" visible onClose={onClose}>
			<Heading>Search engine</Heading>
			{(Object.keys(ENGINE_NAMES) as Engine[]).map((engine) => (
				<Row
					key={engine}
					label={ENGINE_NAMES[engine]}
					note={engine === "google" ? "Google asks you to prove you're not a robot through the relay more often" : undefined}
					checked={settings.search === engine}
					onPress={() => onChange({ search: engine })}
				/>
			))}

			<Heading>Security level</Heading>
			{LEVELS.map(({ level, name, note }) => (
				<Row key={level} label={name} note={note} checked={settings.level === level} onPress={() => onChange({ level })} />
			))}

			<Heading>Privacy</Heading>
			<Row
				label="Answer cookie notices"
				note="Says no to tracking for you, where the notice offers that, and hides it"
				right={<Switch accessibilityLabel="Answer cookie notices" value={settings.consent} onValueChange={(consent) => onChange({ consent })} />}
			/>

			<Heading>Server</Heading>
			<Row label={server} note="Relay sites go through it, and it checks addresses against its phishing and malware lists." />
			<Row label="Sign out" danger onPress={signOut} />
		</Sheet>
	);
}

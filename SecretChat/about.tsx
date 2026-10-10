/*
 * SecretChat – "How secure is it?" in the plugin's settings: which algorithms are used, what they protect and
 * what they don't, so everyone can judge for themselves how secret SecretChat is.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Note, Row, Section, State } from "../_ui";

const Algo = ({ title, what, detail, algo }: { title: string; what: string; detail: string; algo: string; }) => (
    <Row title={title} subtitle={what} note={detail} trailing={<b>{algo}</b>} align="top" />
);

export function About() {
    return (
        <div>
            <Note tone="ok">
                Messages and files are encrypted on your PC before they reach Discord. Discord, Catbox and Gofile only
                ever get random-looking bytes – only people who have the key can turn them back into the original.
                There is no SecretChat server: keys go straight from person to person.
            </Note>

            <Section title="Algorithms" footer="All of them are open standards used by Signal, WhatsApp, TLS 1.3 (HTTPS) and WireGuard. Nothing is home-made except the code that puts them together.">
                <Algo
                    title="Messages"
                    what="Text and edits"
                    detail="256-bit key, a fresh random 96-bit nonce per message and a 128-bit tag. The sender's user id is bound into the tag, so nobody can repost your message under their name."
                    algo="ChaCha20-Poly1305"
                />
                <Algo
                    title="Files"
                    what="Pictures, videos, any file – also name, type and size"
                    detail="Each file gets its own key, derived from the chat key. Big files go to Catbox / Gofile already encrypted, under a random name."
                    algo="AES-256-GCM"
                />
                <Algo
                    title="Key exchange"
                    what="“Start encrypted chat” and joining secret rooms"
                    detail="Hybrid: classic ECDH P-256 plus ML-KEM-768 (FIPS 203, Kyber). The chat key needs both secrets, so an attacker has to break both. Same idea as Signal's PQXDH and Chrome's X25519MLKEM768."
                    algo="ECDH + ML-KEM-768"
                />
                <Algo
                    title="Password keys"
                    what="Group keys made from a password"
                    detail="310,000 rounds make guessing slow – but the key is only as strong as the password. Use a long one."
                    algo="PBKDF2-SHA-512"
                />
                <Algo
                    title="Key derivation"
                    what="Chat key, file key, key id, safety code"
                    detail="A hash, not encryption: it turns the exchanged secrets into keys and fingerprints."
                    algo="SHA-512"
                />
                <Algo
                    title="Randomness"
                    what="Keys and nonces"
                    detail="crypto.getRandomValues – the operating system's secure random generator."
                    algo="OS CSPRNG"
                />
            </Section>

            <Section
                title="Quantum computers"
                footer="Keys made before the hybrid handshake show “Not quantum-safe” in the key list. Delete them and start the encrypted chat again to get a quantum-safe key."
            >
                <Row title="Key exchange (ECDH + ML-KEM-768)" trailing={<State tone="ok" check>Safe</State>} />
                <Row title="ChaCha20 and AES with 256-bit keys" subtitle="A quantum computer halves the strength to 128 bit – still far out of reach" trailing={<State tone="ok" check>Safe</State>} />
                <Row title="SHA-512, PBKDF2" trailing={<State tone="ok" check>Safe</State>} />
                <Row title="Keys from the older ECDH-only handshake" subtitle="Recorded handshakes could be broken by a future quantum computer" trailing={<State tone="warn">Not safe</State>} />
            </Section>

            <Section title="What Discord can still see" footer="SecretChat hides what you say, not that you talk.">
                <Row title="Who writes to whom, when, and how often" />
                <Row title="That a message is encrypted, and roughly how long it is" />
                <Row title="Roughly how big a file is (original + 16 bytes)" />
                <Row title="Reactions, names, avatars, chat and server names" />
                <Row title="Voice and video calls – they are not encrypted by SecretChat" />
            </Section>

            <Section title="Limits – be honest with yourself">
                <Row
                    title="Compare the safety code"
                    note="A handshake runs through Discord. Discord (or someone in its place) could swap the keys in between. If the safety codes match on both sides – checked in a call or in person – nobody did."
                    align="top"
                />
                <Row
                    title="Keys are stored on your PC"
                    note="In Discord's local storage, not locked with a password. Anyone with access to your PC or a virus on it can read them – and then your messages."
                    align="top"
                />
                <Row
                    title="One key per chat"
                    note="If a key leaks, every message sent with it can be read. Delete the key and connect again to start over with a new one."
                    align="top"
                />
                <Row
                    title="Not audited"
                    note="The algorithms are standard, but SecretChat itself was never checked by outside security experts. The ML-KEM code comes from @noble/post-quantum, a well-known library that is self-audited."
                    align="top"
                />
            </Section>
        </div>
    );
}

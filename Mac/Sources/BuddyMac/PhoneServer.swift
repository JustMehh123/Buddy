import Foundation
import Network
import BuddyShared

/// Whether the far end of a connection is this machine. Filled in when the
/// connection is ready, read when a packet arrives.
private final class PeerPath {
    var isLocal = false
}

/// Advertises the Mac on the local network and streams face updates to any phone that connects.
final class PhoneServer {
    private var listener: NWListener?
    private var phones: [ObjectIdentifier: (link: LineConnection, name: String?)] = [:]
    private var pending: [ObjectIdentifier: LineConnection] = [:]
    private var lastSent: FaceState?
    private var lastSentAt = Date.distantPast
    private var restartWork: DispatchWorkItem?

    /// Called with the names of connected phones whenever that list changes.
    var onPhonesChanged: (([String]) -> Void)?

    /// Called when a phone asks for something. The second argument replies to that phone.
    var onRequest: ((Packet, @escaping (Packet) -> Void) -> Void)?

    /// The secret the bridge signs its commands with. Anyone else on the Wi-Fi
    /// can reach this port, and this port can move the mouse.
    private let bridgeToken = Keychain.bridgeToken
    private var warnedAbout = false

    var phoneNames: [String] { phones.values.map { $0.name ?? "iPhone" } }

    func start() {
        do {
            let listener = try NWListener(using: .buddy)
            listener.service = NWListener.Service(name: Host.current().localizedName ?? "Mac", type: BuddyService.type)
            listener.newConnectionHandler = { [weak self] connection in
                self?.accept(connection)
            }
            listener.stateUpdateHandler = { [weak self] state in
                if case .failed = state { self?.scheduleRestart() }
            }
            listener.start(queue: .main)
            self.listener = listener
        } catch {
            NSLog("Buddy: could not start listener: \(error)")
            scheduleRestart()
        }
    }

    private func scheduleRestart() {
        listener?.cancel()
        listener = nil
        restartWork?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.start() }
        restartWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 2, execute: work)
    }

    private func accept(_ connection: NWConnection) {
        let link = LineConnection(connection)
        let id = ObjectIdentifier(link)
        // Anything on this machine is already the user; anything on the network
        // has to prove it is the bridge. Which one it is only becomes known
        // when the connection is ready, so the answer is kept in a box.
        let peer = PeerPath()
        pending[id] = link  // keep it alive until it is ready
        link.onState = { [weak self, weak link] state in
            guard let self, let link else { return }
            switch state {
            case .ready:
                peer.isLocal = Self.isLoopback(connection.currentPath?.remoteEndpoint)
                self.pending[id] = nil
                self.phones[id] = (link, nil)
                link.send(Packet(hello: Host.current().localizedName ?? "Mac"))
                if let face = self.lastSent { link.send(Packet(face: face)) }
                self.onPhonesChanged?(self.phoneNames)
            case .failed, .cancelled:
                self.pending[id] = nil
                self.phones[id] = nil
                self.onPhonesChanged?(self.phoneNames)
            default:
                break
            }
        }
        link.onPacket = { [weak self] packet in
            guard let self, self.phones[id] != nil else { return }
            if !peer.isLocal, packet.auth != self.bridgeToken {
                // Not the bridge. Nothing this connection says is acted on.
                if !self.warnedAbout {
                    self.warnedAbout = true
                    NSLog("Buddy: turned away a connection that did not have the bridge secret")
                }
                return
            }
            if let name = packet.hello {
                self.phones[id]?.name = name
                self.onPhonesChanged?(self.phoneNames)
            }
            if packet.command != nil {
                self.onRequest?(packet) { [weak link] response in link?.send(response) }
            }
        }
        link.start()
    }

    /// True for a connection that came from this machine itself. Anything else
    /// has to carry the bridge secret, including a connection whose origin
    /// cannot be worked out (that is the safe way round).
    private static func isLoopback(_ endpoint: NWEndpoint?) -> Bool {
        guard case let .hostPort(host, _)? = endpoint else { return false }
        switch host {
        case .ipv4(let address): return address.isLoopback
        case .ipv6(let address): return address.isLoopback
        case .name(let name, _): return name == "localhost" || name == "127.0.0.1" || name == "::1"
        @unknown default: return false
        }
    }

    /// Sends a command to every phone (e.g. "wake", "sleep").
    func broadcast(_ packet: Packet) {
        for phone in phones.values { phone.link.send(packet) }
    }

    /// Sends the face to every phone, skipping updates too small to see.
    func send(_ face: FaceState) {
        // Resend at least once a second even when nothing changed, so the phone knows the Mac is still driving.
        let now = Date()
        if let last = lastSent, now.timeIntervalSince(lastSentAt) < 1,
           last.mood == face.mood,
           abs(last.gazeX - face.gazeX) < 0.004,
           abs(last.gazeY - face.gazeY) < 0.004,
           abs(last.talk - face.talk) < 0.02 {
            return
        }
        lastSent = face
        lastSentAt = now
        for phone in phones.values { phone.link.send(Packet(face: face)) }
    }
}

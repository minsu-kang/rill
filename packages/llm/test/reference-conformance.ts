import type { ProviderConformance } from './conformance'
import type { FakeTransport } from './fake-transport'
import { PLAIN_CAPABILITIES, ReferenceProvider, type ReferenceFault } from './reference-provider'
import { referenceWire, type ReferenceVariant } from './reference-wire'

export function referenceConformance(fault?: ReferenceFault, variant: ReferenceVariant = 'full'): ProviderConformance {
  return {
    name: `reference provider (${variant}${fault === undefined ? '' : `, fault ${fault}`})`,
    build: (transport: FakeTransport) =>
      new ReferenceProvider({
        apiKey: transport.apiKey,
        fetch: transport.fetch,
        sleep: transport.sleep,
        random: transport.random,
        ...(fault === undefined ? {} : { fault }),
        ...(variant === 'plain' ? { capabilities: PLAIN_CAPABILITIES } : {}),
      }),
    wire: [referenceWire(false, variant), referenceWire(true, variant)],
    effortPath: ['reasoning', 'level'],
  }
}


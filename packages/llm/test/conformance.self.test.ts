import { describeProviderConformance } from './conformance'
import { referenceConformance } from './reference-conformance'

describeProviderConformance(referenceConformance())
describeProviderConformance(referenceConformance(undefined, 'plain'))

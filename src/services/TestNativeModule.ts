import { NativeModules } from 'react-native'

interface TestModuleInterface {
  getString(): Promise<string>
}

const { TestModule } = NativeModules

export default TestModule as TestModuleInterface

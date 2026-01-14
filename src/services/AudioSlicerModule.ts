import { NativeModules } from 'react-native'

interface AudioSlicerInterface {
  sliceAudio(
    inputPath: string,
    startTimeMs: number,
    endTimeMs: number,
    outputPath: string
  ): Promise<string>
}

const { AudioSlicer } = NativeModules

export default AudioSlicer as AudioSlicerInterface

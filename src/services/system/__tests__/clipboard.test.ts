import * as Clipboard from 'expo-clipboard'
import { ToastAndroid } from 'react-native'
import { copyText } from '../clipboard'

jest.mock('expo-clipboard', () => ({
  setStringAsync: jest.fn().mockResolvedValue(true),
}))

describe('copyText', () => {
  it('copies the value to the clipboard', () => {
    copyText('hello world')

    expect(Clipboard.setStringAsync).toHaveBeenCalledWith('hello world')
  })

  it('shows a confirmation toast', () => {
    const show = jest.spyOn(ToastAndroid, 'show').mockImplementation(() => {})

    copyText('hello world')

    expect(show).toHaveBeenCalledWith('Copied', ToastAndroid.SHORT)
  })
})

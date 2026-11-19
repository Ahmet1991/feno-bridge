!macro customInit
  ${If} $INSTDIR == "$LocalAppData\Programs\Codex Web GPT"
    StrCpy $INSTDIR "$LocalAppData\Programs\Feno Bridge"
  ${EndIf}
!macroend

!macro customInstall
  ExecWait '"$INSTDIR\resources\runtime\runtime\chrome-native-host.exe" --manifest' $0
  ${If} $0 == 0
    WriteRegStr HKCU "Software\Google\Chrome\NativeMessagingHosts\com.feno.bridge.pc2" "" "$INSTDIR\resources\chrome-native-host.json"
  ${Else}
    DetailPrint "Feno Bridge PC2 Chrome native host manifest generation failed."
  ${EndIf}
!macroend

!macro customUnInstall
  DeleteRegKey HKCU "Software\Google\Chrome\NativeMessagingHosts\com.feno.bridge.pc2"
!macroend

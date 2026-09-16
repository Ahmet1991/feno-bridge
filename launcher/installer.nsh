!macro customInit
  ${If} $INSTDIR == "$LocalAppData\Programs\Codex Web GPT"
    StrCpy $INSTDIR "$LocalAppData\Programs\Feno Bridge"
  ${EndIf}
!macroend

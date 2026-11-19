using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows.Forms;
using System.Diagnostics;

public static class ForegroundProbe {
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);

    // Observe the current foreground without activating a test window.
    public static void RunPassive(string directory) {
        string ready=Path.Combine(directory,"foreground-ready");
        string stop=Path.Combine(directory,"foreground-stop");
        string log=Path.Combine(directory,"foreground.csv");
        try {
            while(!File.Exists(stop)) {
                IntPtr hwnd=GetForegroundWindow();
                uint owner;GetWindowThreadProcessId(hwnd,out owner);
                string name="unknown";try{using(Process p=Process.GetProcessById((int)owner))name=p.ProcessName;}catch{}
                File.AppendAllText(log,DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()+","+hwnd.ToInt64()+","+owner+","+name+Environment.NewLine);
                if(!File.Exists(ready))File.WriteAllText(ready,hwnd.ToInt64().ToString());
                System.Threading.Thread.Sleep(100);
            }
        } finally {File.WriteAllText(Path.Combine(directory,"foreground-done"),"done");}
    }

    public static void Run(string directory) {
        string ready=Path.Combine(directory,"foreground-ready");
        string stop=Path.Combine(directory,"foreground-stop");
        string log=Path.Combine(directory,"foreground.csv");
        using(Form form=new Form {Text="PC2 focus smoke - test window",Width=480,Height=180,StartPosition=FormStartPosition.CenterScreen})
        using(Timer timer=new Timer {Interval=200}) {
            form.Controls.Add(new Label {Text="Automated foreground sampling (200 ms)",AutoSize=true,Left=20,Top=30});
            int consecutive=0;
            timer.Tick+=(sender,eventArgs)=>{
                IntPtr hwnd=GetForegroundWindow();
                uint owner;GetWindowThreadProcessId(hwnd,out owner);
                string name="unknown";try{using(Process p=Process.GetProcessById((int)owner))name=p.ProcessName;}catch{}
                File.AppendAllText(log,DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()+","+hwnd.ToInt64()+","+owner+","+name+Environment.NewLine);
                consecutive=hwnd==form.Handle?consecutive+1:0;
                if(consecutive>=3&&!File.Exists(ready))File.WriteAllText(ready,form.Handle.ToInt64().ToString());
                if(File.Exists(stop)){timer.Stop();form.Close();}
            };
            form.Shown+=(sender,eventArgs)=>{form.Activate();timer.Start();};
            Application.Run(form);
        }
    }
}

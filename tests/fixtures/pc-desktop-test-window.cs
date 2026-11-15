// One-time desktop E2E fixture: a window created by the test, never a user app.
using System;
using System.IO;
using System.Text;
using System.Windows.Forms;

internal static class OwnDesktopFixture {
    [STAThread]
    private static int Main(string[] args) {
        if(args.Length!=4 || args[0]!="--title" || args[2]!="--log")return 1;
        Application.EnableVisualStyles();
        using(Form form=new Form()) {
            form.Text=args[1];form.Width=620;form.Height=320;
            form.StartPosition=FormStartPosition.CenterScreen;
            TextBox box=new TextBox {Multiline=true,Dock=DockStyle.Fill,AccessibleName="Feno PC2 E2E own test editor"};
            form.Controls.Add(box);
            box.TextChanged+=delegate {File.WriteAllText(args[3],box.Text,new UTF8Encoding(false));};
            form.Shown+=delegate {box.Focus();};
            Application.Run(form);
        }
        return 0;
    }
}
